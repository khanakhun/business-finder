# @bf/ai — LLM gateway

The only package that calls model providers ([ADR-0011](../../docs/adr/0011-llm-gateway-ai-sdk-and-prompt-registry.md),
[ai-engineering.md](../../docs/conventions/ai-engineering.md)). Built on the Vercel AI SDK **7.0.135**
(`@ai-sdk/anthropic` 4.0.78, `@ai-sdk/openai` 4.0.91, `@ai-sdk/otel` 1.0.135).

Feature code never picks a provider or a model:

```ts
const result = await ai.run(DemoExtractBusinessFacts, { businessName, websiteUrl, pageText }, { orgId });
result.output; // typed by the task's Zod schema
```

`run` (structured or text), `stream` (text), `embed` and `vision` all get: budget check → response cache →
model chain (primary + fallbacks) with retries (jittered backoff) and a circuit breaker per provider → one schema
repair round → cost from `AI_PRICING` → an `llm_calls` ledger row → an `ai.task <name>` OTel span (AI SDK spans
nested, exported to Langfuse when configured).

## Adding a task

1. Write the schemas and the task in `src/tasks/<task>.ts` with `defineTask({ name, kind, tier, prompt, input,
   output, temperature, maxOutputTokens, timeoutMs, cacheTtlSeconds?, cacheScope?, essential?, variables? })`.
   - `tier` (`fast` | `smart` | `agent`) maps to a model in the routing table (`AI_MODEL_*`, `AI_MODEL_OVERRIDES`).
   - `cacheScope: 'global'` only when the input has no workspace-private data (default: per workspace).
   - `essential: true` only for tasks that must run past the workspace's hard budget (e.g. reply triage).
2. Add the prompt `prompts/<task>.v1.md` (frontmatter `task`, `version`, `tier`, `changelog`; `# System` and
   `# User` sections). Variables are `{{name}}`, `{{a.b}}` and `{{#each list}}…{{/each}}`; **a missing variable
   fails** instead of rendering a blank. Never edit a released version: copy to `v<N+1>` and point the task at it.
3. Add an eval set `evals/<task>/dataset.jsonl` (`{ id, input, expected, tags }`, fake data, EN and FR) and
   `evals/<task>/eval.config.ts` (`defineEval({ task, scorers, thresholds })`). Scorers: `exactMatch`, `setF1`,
   `numericTolerance`, `jsonPathMatch`, `llmJudge` (rubric; prefer another model family).
4. Record fixtures (below) so tests and CI run without a network.

## Untrusted data

Website text, reviews, emails and provider payloads go into prompts **only** through
`untrusted(source, text, { maxChars, id })`: control and invisible characters are stripped, whitespace collapsed,
the text truncated, and any `<untrusted_data>`/`</untrusted_data>` inside it defused so it cannot close the block
early. Every system prompt that sees such data includes `UNTRUSTED_DATA_RULES` (treat as data, ignore
instructions, report suspected injection in `warnings`). Tests: `src/core.test.ts`.

## Tests and fixtures

Unit tests use AI SDK mock models (`ai/test`); MSW fails any real HTTP request (`test/no-network.ts`).
`@bf/ai/testing` provides:

- `createFakeAiGateway({ fixturesDir, mode: 'replay' })` — answers from `fixtures/<task>/v<N>/<hash>.json`, keyed by
  task, prompt version and input; a missing fixture throws with the path to create.
- `fakeEmbedding(text, dims)` — deterministic unit vectors for search tests.

### Recording fixtures

With real keys (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in your shell):

```sh
pnpm eval --task demo.extract_business_facts --record   # runs live and writes fixtures/
```

Review the recorded answers before committing them (they must not contain personal data). The demo task's current
fixtures are hand-written (no keys were available when it was built).

Without keys, `node scripts/write-replay-fixtures.ts <task>` writes replay fixtures from
`evals/<task>/replay-outputs.jsonl` (one answer per dataset row, same order). `reviews.extract_pain_signals` uses it:
its answers are simulated (realistic mistakes included), not recorded — record real ones before trusting the
thresholds.

## Evals

```sh
pnpm eval --task <name> [--model <id>] [--limit <n>]   # real models (costs money)
pnpm eval --task <name> --replay                        # recorded fixtures (what CI runs)
```

Reports go to `evals/reports/<task>-<timestamp>.{md,json}` (not versioned; attach them to the PR). The run fails
below the thresholds (`thresholds`, minimum means) or above `maxThresholds` (lower-is-better metrics). Besides
per-row scorers, `aggregates` compute dataset-level metrics over every row at once (`macroF1`, `meanAbsoluteError`). `.github/workflows/evals.yml` runs evals on real models nightly or on demand and skips when
no provider key secret is set; `pnpm verify` runs each eval on its fixtures.

## Configuration (apps/api)

`AI_MODEL_FAST|SMART|AGENT`, `AI_MODEL_OVERRIDES` (task → model), `AI_MODEL_FALLBACKS` (model or tier → models),
`AI_EMBEDDING_MODEL`, `AI_PRICING` (model → USD per million input/output/cached tokens), `AI_TRACE_CONTENT`,
`LANGFUSE_*`, budgets. Model ids are written `provider:id` or as bare ids (`claude-*` → Anthropic,
`gpt-*`/`o<N>*`/`text-embedding-*` → OpenAI).
