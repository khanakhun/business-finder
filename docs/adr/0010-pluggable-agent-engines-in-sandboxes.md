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

## Addendum (BF-043, 2026-10-17): sandbox network, egress and Docker access as built

- **Socket proxy verbs.** The worker reaches Docker through `wollomatic/socket-proxy` (1.13.1), which allows exactly
  what a run needs: `POST containers/create`, `containers/{id}/attach|start|wait|kill`, `DELETE containers/{id}`,
  `GET containers/json`, `containers/{id}/json`, `images/{ref}/json`, `_ping`, `version`. Everything else (exec, info,
  volumes, image pulls, networks) is refused. The proxy cannot inspect request bodies: a compromised worker could
  still create a privileged container. A narrow "sandbox broker" that builds the container config itself is the
  BF-060 follow-up.
- **Egress.** Sandboxes sit on the internal network `bf-sandbox` (no route out). The only way out is an in-house
  CONNECT proxy (`services/egress-proxy`): HTTPS `CONNECT` to port 443 of allowlisted hostnames only (profile
  `models`: `api.anthropic.com`, `api.openai.com`; `models_assets` adds the stock CDNs), the name resolved by the
  proxy and the tunnel opened to a public address only (no private, loopback, link-local or metadata address — no DNS
  rebinding), IP literals and plain HTTP refused, every refusal logged and counted (`sandbox_egress_denied_total{host}`).
  Considered: Stripe's smokescreen (the right model, but no maintained image to pin) and Squid (`CONNECT`-only ACLs
  work, but per-host denial metrics need a log pipeline). A 150-line proxy with a test suite was simpler to own.
- **Inter-container traffic.** Sandboxes expose no ports; they could reach each other on `bf-sandbox`. A network per
  run is optional hardening, evaluated in BF-060.
- **Runner image.** Same digest-pinned Node base as the API; Claude Code and Codex CLIs pinned by build args; npm and
  corepack removed from the runtime; every tmpfs `noexec`. The security suite
  (`services/agent-runner/security-tests`) checks identity, filesystem, capabilities, process limits, network,
  egress and the socket proxy's rules in CI.

## Addendum (BF-044 part 1, 2026-10-17): the coding-agent engines' common run and Claude Code's flags

- **Accepting a result.** A sandboxed engine accepts a site only when the agent ended cleanly, the supervisor's
  `sitekit check` reported `done: true`, **and** our own validation passed outside the sandbox. That validation is
  sitekit's validator with strict facts against the registry in the bundle the worker built (never the agent's copy
  of `facts.json`, which is not even collected), plus copy-lint errors. The agent's final report is logged, never
  trusted.
- **Errors.** `ENGINE_INCOMPLETE` (retried), `ENGINE_INVALID_OUTPUT` (retried once, then failover), and two codes
  that skip retries and fail over at once: `ENGINE_BUDGET_EXCEEDED` and `ENGINE_VERSION_UNSUPPORTED` (the
  supervisor's `versions` frame is checked against the range the parser was written for).
- **Default failover order.** The coding agents first, `blocks` last, so a coding agent's job ends on blocks (this
  ADR's "default fallback blocks").
- **Budget.** The agent gets the attempt's budget minus a margin (15%) as its own limit. The worker also prices the
  stream's tokens as they come (`AI_PRICING`) and stops the sandbox when spend reaches the attempt's budget.
- **Claude Code flags, verified on 2.1.288** (`claude --help` in the runner image; the CLI reference, headless and
  settings docs):
  - Non-bare `-p` with `--output-format stream-json --verbose`, `--permission-mode dontAsk` and
    `--permission-prompts none`.
  - `--tools Read,Edit,Write,Glob,Grep,Bash`. `--bare` caps the built-in tools at Bash/Edit/Read, and `--tools`
    cannot widen that.
  - `--allowedTools …,Bash(sitekit *)` (a prefix rule on the command as written) and
    `--disallowedTools WebFetch,WebSearch,Task,Skill,NotebookEdit`.
  - `--setting-sources=` and `--strict-mcp-config`.
  - `--append-system-prompt-file` with our rules, which are also the workspace's `AGENTS.md`.
  - `--json-schema` with the final report schema inline (the flag does not take a file).
  - `--max-turns`, `--max-budget-usd` and `--no-session-persistence`.
  - Env: telemetry, updates and memory off. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is not set. It needs bubblewrap, which
    cannot run under the sandbox's seccomp profile, and with it 2.1.288 refuses to start any subprocess (found in part
    3 by running the real CLI). The agent's only subprocess is sitekit, our own code.
  - The sitekit-over-MCP variant (`--mcp-config` with `sitekit mcp`, no Bash at all) is behind
    `GENERATION_CLAUDE_CODE_SITEKIT=mcp`. The default (`bash`) is provisional until the benchmark runs with keys.
- **Codex's own sandbox does not run in ours.** Its bubblewrap sandbox cannot create user namespaces under Docker's
  default seccomp profile, and the Landlock fallback panics in 0.160.0 (observed in the runner image). Part 2 decides
  between Codex's documented flag for externally sandboxed environments and a custom seccomp profile, with evidence.

## Addendum (BF-044 part 2, 2026-10-17): Codex runs without its own sandbox, inside ours

- **Evidence** (observed in the runner image with Codex CLI 0.160.0, offline): `codex sandbox` with `workspace-write`
  fails with bubblewrap's "No permissions to create a new namespace" under Docker's default seccomp profile. The
  legacy Landlock fallback panics ("filesystem-restricted execution requires bubblewrap"). With
  `--security-opt seccomp=unconfined`, the inner sandbox works.
- **Decision.** Run `codex exec --dangerously-bypass-approvals-and-sandbox`, the flag Codex documents for
  "environments that are externally sandboxed". Claude Code already runs this way, with no inner sandbox. Our
  container is the sandbox: no capabilities, read-only root, `noexec` tmpfs, no network but the models-only egress
  proxy, a per-run key and a wall time.
- **Rejected:** a custom seccomp profile that allows unprivileged user namespaces, so Codex's bubblewrap could add a
  second layer. User namespaces are a recurring kernel privilege-escalation surface. Opening them for every sandbox
  to gain an inner layer that does not restrict the network further (ours already does) trades a broad risk for a
  narrow benefit. Revisit if Codex's sandbox can run without user namespaces.
- **Codex specifics:**
  - Usage arrives only with `turn.completed`, as cumulative totals, and Codex reports no USD.
  - The worker prices the tokens (`AI_PRICING` must carry `GENERATION_CODEX_MODEL`) and refuses a run past the
    budget (`ENGINE_BUDGET_EXCEEDED`). `exec` is one turn, so within the turn the wall time bounds the spend.
  - Top-level `error` events are reconnects, logged and not fatal.
  - `shell_environment_policy.inherit = "core"` keeps `CODEX_API_KEY` out of the commands it runs.
