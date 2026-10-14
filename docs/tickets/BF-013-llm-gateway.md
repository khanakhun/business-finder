---
id: BF-013
title: LLM gateway, prompt registry, cost ledger and eval harness (@bf/ai)
milestone: M1 Find & List
epic: ai-platform
type: feature
priority: P0
size: L
depends_on: [BF-004, BF-005, BF-011]
blocks: [BF-015, BF-021, BF-022, BF-029, BF-030, BF-038, BF-039, BF-040, BF-041, BF-045, BF-047, BF-051, BF-054]
areas: [ai, api]
---

# BF-013 — LLM gateway, prompt registry, cost ledger and eval harness (@bf/ai)

## Context
LLMs power intent parsing, classification, review mining, vision audits, site copy, critics, email drafting and reply triage. [ADR-0011](../adr/0011-llm-gateway-ai-sdk-and-prompt-registry.md) mandates a single gateway on the Vercel AI SDK with routing, prompt registry, structured outputs, cost ledger, tracing (Langfuse via OTel), a fake provider for tests and an eval harness. Conventions: [ai-engineering.md](../conventions/ai-engineering.md). Provider keys come from the secrets vault with env fallback (BF-011).

## Goal
Feature code calls `ai.run(task, input, ctx)` / `ai.stream(...)` / `ai.embed(...)` / `ai.vision(...)` with typed inputs and outputs, and gets routing, retries, repair, caching, budgets, tracing and cost recording for free; tests run against recorded fixtures; prompt changes are evaluated with `pnpm eval`.

## Scope
**In scope**
- `packages/ai` (`@bf/ai`):
  - `defineTask({ name, tier, prompt, input, output, temperature, maxOutputTokens, timeoutMs, cacheTtlSeconds?, evalSet?, kind: 'object'|'text'|'vision' })`.
  - `createAiGateway({ routing, keyResolver, cache, recorder, budget, telemetry, clock })` returning `{ run, stream, embed, vision }`.
  - Routing table (config, overridable by env): tiers `fast` (`claude-haiku-5-5`), `smart` (`claude-sonnet-5-5`), `agent` (`claude-opus-5-5`); per-task overrides; fallback chain (e.g. Anthropic → OpenAI equivalent) on provider outage. Model IDs only in config.
  - Providers via AI SDK (`@ai-sdk/anthropic`, `@ai-sdk/openai`); provider instances created per call with keys from `KeyResolver` (`(orgId, provider) → key`, backed by `SecretResolver`).
  - Prompt registry: loads `packages/ai/prompts/*.v<N>.md` (frontmatter + `# System` / `# User` sections), validates frontmatter, renders variables with a logic-less engine that **fails on missing variables**; exposes `prompt.version` for caching/telemetry.
  - `untrusted(source, text, { maxChars })` helper producing the `<untrusted_data>` wrapper with sanitization (strip control chars, collapse whitespace, truncate).
  - Structured output via AI SDK object generation with Zod; on validation failure one repair round including the validation error; then `AiOutputInvalidError`.
  - Resilience: timeouts, retries with jitter on 429/5xx/overloaded, circuit breaker per provider, fallback chain.
  - Caching: Valkey, key = hash(task, prompt version, model, normalized input, orgScope?); org-private inputs scoped by org.
  - Cost: pricing table in config (`AI_PRICING` JSON; per model input/output/cached-token prices; easy to update when prices change) → `costUsd` per call.
  - `LlmCallRecorder` port: writes to `llm_calls` (table owned by api `platform/ai`: `id`, `organization_id`, `task`, `prompt_version`, `provider`, `model`, `input_tokens`, `output_tokens`, `cached_tokens`, `cost_usd`, `latency_ms`, `status`, `error_code`, `trace_id`, `created_at`).
  - Budgets: `BudgetGuard` checks org monthly spend (soft → warn event; hard → block non-essential tasks with `BudgetExceededError`; tasks declare `essential: boolean`).
  - Telemetry: AI SDK telemetry spans (prompt version, task, model, tokens, cost) exported via OTel; Langfuse via its OTel integration (verify the current recommended setup) when `LANGFUSE_*` env is set; prompt/response bodies sent to Langfuse only when `AI_TRACE_CONTENT=true` (default false in production) and with email/phone redaction.
  - Embeddings: `embed(texts[], { purpose })` with configurable model (default OpenAI `text-embedding-3-small`, 1536 dims; Voyage supported if configured), batching, caching per text hash; returns `{ vectors, model, dims }`.
  - Vision: images as URLs or bytes; resizing guidance enforced (max dimension) via sharp before sending.
  - Testing utilities `@bf/ai/testing`: `createFakeAiGateway({ fixturesDir, mode: 'replay'|'record' })` keyed by (task, prompt version, input hash); helpful error for missing fixtures; deterministic fake embeddings (hash-based vectors) for search tests.
  - Eval harness: `pnpm eval --task <name> [--model <id>] [--limit n]` reads `evals/<task>/*.jsonl`, runs the task, applies scorers declared in `evals/<task>/eval.config.ts` (exact, set-F1, numeric tolerance, JSON-path match, LLM-judge with rubric), writes a markdown + JSON report to `evals/reports/`, fails below thresholds. A GitHub workflow `evals.yml` (manual dispatch + nightly, uses repository secrets) — skipped when secrets are absent.
- `apps/api` `platform/ai` module: provides the gateway (DI token `AI_GATEWAY`) with `KeyResolver` (secrets vault), recorder (Drizzle), cache (Valkey), budget guard (llm_calls aggregate), and an admin endpoint `GET /v1/ai/usage` (by task/model/day) for `settings:manage`.
- A minimal sample task `demo.extract_business_facts` (prompt, schema, 10-row eval set, fixtures) to prove the full path; feature tickets add real tasks.

**Out of scope**
- Feature tasks (intent parsing → BF-021, classification → BF-015, etc.). Agent SDK / coding CLIs (→ BF-043/BF-044). Usage dashboard UI (→ BF-058; this ticket provides the API).

## Requirements
### Functional
- Changing a task's model is a config change; changing a prompt requires a new prompt file version.
- Missing provider key for an org → typed `AiProviderNotConfiguredError` with the secret name to set.
### Non-functional
- Gateway overhead < 5 ms per call (excluding provider latency).
- No real network calls in unit/integration tests (enforced by MSW `onUnhandledRequest: 'error'`).

## Design
```
packages/ai/
├── prompts/demo.extract_business_facts.v1.md
├── evals/demo.extract_business_facts/{dataset.jsonl, eval.config.ts}
├── src/{gateway.ts, define-task.ts, routing.ts, providers.ts, prompts/registry.ts, prompts/render.ts,
│        untrusted.ts, cache.ts, cost.ts, budget.ts, telemetry.ts, embeddings.ts, vision.ts, errors.ts}
├── src/testing/{fake-gateway.ts, fixtures.ts, fake-embeddings.ts}
└── scripts/eval.ts
apps/api/src/modules/platform/ai/{ai.module.ts, key-resolver.ts, llm-call.repository.ts, usage.controller.ts}
```
- Patterns: Facade (gateway), Strategy (providers/scorers), Decorator (cache, retry, budget, telemetry around the core call), Registry (tasks, prompts).

## Implementation plan
1. Verify current AI SDK major version APIs (object generation, streaming, telemetry, provider packages) and Langfuse's OTel integration.
2. Core: define-task, routing, prompt registry/renderer, untrusted helper (unit tests).
3. Gateway core + decorators (cache, resilience, budget, telemetry, recorder) with fake provider tests.
4. Embeddings + vision helpers.
5. Testing utilities (record/replay) and eval harness + workflow.
6. API module wiring, `llm_calls` table, usage endpoint.
7. Demo task end-to-end with fixtures and eval.

## Testing
- Unit: prompt rendering (missing var fails), frontmatter validation, untrusted wrapper sanitization/truncation, cost computation, cache key determinism, budget soft/hard, repair round success/failure, fallback chain on simulated outage.
- Integration: api module records `llm_calls` rows; usage endpoint aggregates; key resolution (workspace vs global).
- Eval harness: runs on a fake gateway with fixtures (CI) and produces a report.

## Acceptance criteria
- [ ] `@bf/ai` exposes run/stream/embed/vision with routing, structured output + repair, resilience, cache, cost, budgets, telemetry.
- [ ] Prompts are versioned files; rendering fails on missing variables.
- [ ] `llm_calls` ledger populated; `GET /v1/ai/usage` returns aggregates.
- [ ] Fake gateway with record/replay fixtures; tests never hit the network.
- [ ] `pnpm eval --task demo.extract_business_facts` works with real keys and fails below threshold; workflow skips without secrets.
- [ ] Docs: `packages/ai/README.md` (how to add a task, prompt, eval; how to record fixtures).

## Agent prompt
```text
Implement BF-013 (LLM gateway, prompt registry, cost ledger and eval harness).

Read first: AGENTS.md, docs/adr/0011-llm-gateway-ai-sdk-and-prompt-registry.md, docs/conventions/ai-engineering.md
(all), docs/ARCHITECTURE.md §9, docs/conventions/security.md §6. Reuse SecretResolver (BF-011), Valkey + platform
modules (BF-006), @bf/observability (BF-005).

Rules:
- Verify the current Vercel AI SDK major version and its structured-output, streaming and telemetry APIs, and
  Langfuse's current OTel integration, before writing code. Record versions.
- Model IDs and prices are configuration, never constants in feature code. Defaults: fast=claude-haiku-5-5,
  smart=claude-sonnet-5-5, agent=claude-opus-5-5 (all env-overridable).
- Untrusted data handling is a security feature; test the wrapper and document it in the README.
- Keep the public API small and typed; feature tickets must not need to touch provider SDKs.

Verify: pnpm verify && pnpm test:int; run the demo eval with real keys locally (if available) and attach the
report; otherwise attach the fake-gateway report and note it.
```

## References
- ADR-0011 · docs/conventions/ai-engineering.md · docs/ARCHITECTURE.md §9
- AI SDK: https://ai-sdk.dev/docs · Langfuse: https://langfuse.com/docs · Anthropic models overview: https://docs.claude.com/en/docs/about-claude/models/overview
