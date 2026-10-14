# ADR-0010: Pluggable generation engines; coding agents in sandboxes

- Status: Accepted
- Date: 2026-10-14
- Tickets: BF-039…BF-045

## Context

The user wants to select several businesses and have sites generated automatically, choosing per item between engines (e.g. two jobs with Claude Code and two with Codex in parallel), with priorities. Engines differ in speed, cost, quality and risk. Coding agents execute tools (shell, file edits) and consume untrusted content (crawled websites, reviews), so they need isolation.

## Decision

- **Strategy pattern**: `AgentEngine` interface (see ARCHITECTURE.md §11) with implementations:
  1. `blocks` — in-process composer using structured LLM calls (AI SDK). Fast, cheap, default.
  2. `claude-agent-sdk` — Claude Agent SDK `query()` with in-process `sitekit` MCP tools, running inside the runner container.
  3. `claude-code` — Claude Code CLI in headless mode (`claude --bare -p … --output-format stream-json`).
  4. `codex` — OpenAI Codex CLI non-interactive (`codex exec --json --sandbox workspace-write …`).
  New engines (Gemini CLI, OpenCode, Managed Agents) are added by implementing the interface + registering in the `EngineRegistry` (Factory).
- **One queue per engine** with configurable concurrency; BullMQ priorities for user-set ordering; a global cap on concurrent sandboxes.
- **Sandbox**: coding-agent engines run in the `agent-runner` image via a `SandboxProvider` (default: local Docker Engine API). Isolation: non-root, read-only root FS, tmpfs workspace, CPU/memory/pids limits, no access to Postgres/Valkey/internal network, egress only through an allowlisting proxy (model API hosts, approved image CDNs), wall-time limit, per-run budget (`--max-budget-usd` / token caps) and per-run scoped API keys.
- **Common contract**: every engine receives the same workspace (BRIEF.md, business.json, facts.json, site.json starter, block catalog, assets) and must produce a `site.json` that passes `sitekit validate`. Events are normalized to `EngineEvent` and persisted to `generation_events`.
- **Failover**: per-job attempts; after N failures on an engine the job may fail over to the next engine in the policy (configurable; default fallback `blocks`).
- **Authentication** of CLIs uses API keys (`ANTHROPIC_API_KEY`, `CODEX_API_KEY`) injected per run. Consumer subscription logins are not used for product automation.

## Alternatives considered

| Option | Why not |
|---|---|
| Only one engine | Loses the ability to compare cost/quality and to fail over; user explicitly wants multiple agents. |
| Run coding agents directly on the worker host | Unacceptable blast radius (prompt injection → shell on a host with DB credentials). |
| Hosted sandboxes only (E2B, Vercel Sandbox, Daytona) | Good options and supported via `SandboxProvider`, but local Docker keeps costs down and works offline; choose per deployment. |
| Anthropic Managed Agents | Hosted harness; attractive later for scale. Behind the same engine interface if adopted. |

## Consequences

- Positive: engines are interchangeable, comparable (quality score, cost, time) and safe to run in parallel.
- Negative: we maintain adapters for CLIs whose flags evolve — mitigated by contract tests with recorded JSONL streams and a version check at runner start.
- Negative: Docker-in-production requirement for the worker host (socket access is privileged — the worker talks to a socket proxy that only allows container create/start/kill/logs on the runner image).

## References

- Claude Code headless / Agent SDK CLI: https://code.claude.com/docs/en/headless
- Claude Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- Codex non-interactive mode: https://developers.openai.com/codex/noninteractive
