# ADR-0011: LLM gateway on the Vercel AI SDK with a prompt registry, evals and cost ledger

- Status: Accepted
- Date: 2026-10-14
- Tickets: BF-013, BF-021, BF-029, BF-030, BF-041, BF-051, BF-054

## Context

LLMs are used in many places: search-intent parsing, category classification, review mining, vision audits, site copy, critics, email drafting, reply triage, chat editing. Without a single gateway we would get scattered API keys, hard-coded model IDs, no cost visibility, inconsistent retries and no quality measurement. The user also mentioned LangChain and Mastra.

## Decision

- **`@bf/ai`** is the only package that calls model providers. It exposes task-level functions (`generateStructured(task, input)`, `embed(texts)`, `vision(task, images, input)`, `streamChat(…)`) — callers never choose providers or models directly.
- Built on the **Vercel AI SDK** (`generateObject` / `generateText` / `streamText`, tool calling, `@ai-sdk/anthropic`, `@ai-sdk/openai`) for provider-agnostic structured output with Zod and first-class streaming to React UIs.
- **Routing table** in config: `task → { tier, provider, model, temperature, maxOutputTokens, timeoutMs, fallback }`. Default tiers: fast = `claude-haiku-5-5`, smart = `claude-sonnet-5-5`, agent = `claude-opus-5-5`; OpenAI models available as fallback/alternatives. All overridable by env.
- **Prompt registry**: prompts are versioned Markdown files with frontmatter in `packages/ai/prompts/`; rendering uses typed variables; untrusted data is injected only inside `<untrusted_data>` blocks. Changing a prompt means a new version and a passing eval run.
- **Reliability**: timeouts, retries with jitter on 429/5xx, one schema-repair attempt on invalid structured output, circuit breaker per provider, provider fallback per task.
- **Cost & observability**: every call writes an `llm_calls` ledger row (org, task, model, tokens, cost, latency, status) and an OTel span exported to **Langfuse**; budgets per org/feature with alerts.
- **Testing**: a `fake` provider replays recorded responses keyed by (task, prompt version, input hash); unit and integration tests never hit real models. **Evals** (`packages/ai/evals`) run real models on curated datasets with per-task thresholds (`pnpm eval`), nightly or on prompt changes.
- **Agents**: autonomous agents for site generation use the Claude Agent SDK / coding CLIs (ADR-0010); in-app tool-calling agents (chat edit, inbox assistant) use AI SDK tool calling with least-privilege tools.
- **RAG**: pgvector hybrid retrieval in SQL (ADR-0003). No separate RAG framework.

## Alternatives considered

| Option | Why not (now) |
|---|---|
| LangChain / LangGraph | Large abstraction surface; we need a thin, typed layer. LangGraph is a reasonable future option for complex multi-agent graphs; not needed for v1. |
| Mastra | Coherent TypeScript agent framework (agents, workflows, memory, RAG, evals) built on the AI SDK; overlaps with our BullMQ workflows and SQL RAG. Can be adopted later for chat-based assistants without changing callers, since `@bf/ai` hides it. |
| Direct provider SDKs everywhere | Scattered concerns; no routing/cost/eval discipline. |

## Consequences

- Positive: one place for models, costs, prompts, safety and tests; switching models is a config change validated by evals.
- Negative: the gateway must keep pace with AI SDK major versions — pin and upgrade deliberately.

## References

- AI SDK: https://ai-sdk.dev/docs
- Langfuse: https://langfuse.com/docs
