---
id: BF-043
title: Agent runner sandbox — hardened container image, SandboxProvider (Docker), egress allowlist proxy, framed I/O
milestone: M3 Build
epic: generation
type: feature
priority: P0
size: L
depends_on: [BF-002, BF-025, BF-039, BF-042]
blocks: [BF-044, BF-045, BF-060, BF-061]
areas: [infra, worker, security]
---

# BF-043 — Agent runner sandbox: hardened container image, SandboxProvider (Docker), egress allowlist proxy, framed I/O

## Context
Coding agents execute tools (shell, file edits) and read untrusted content (crawled website excerpts in the workspace). A prompt injection must never reach our database, internal network, secrets or other tenants' data ([ADR-0010](../adr/0010-pluggable-agent-engines-in-sandboxes.md), [security §5](../conventions/security.md#5-coding-agent-sandboxes)). Every `claude-code`, `codex` and `claude-agent-sdk` run therefore happens in a short-lived, locked-down container built from `services/agent-runner`.

The container has no access to Postgres/Valkey/internal services. Its only egress is an allowlisting proxy (model API hosts). Secrets are injected per run without appearing in container metadata. Results come back only as validated artifacts. The orchestrator (BF-039) reserves sandbox slots; engines (BF-044) use the `SandboxProvider` port defined here.

Note on Docker: files in `tmpfs` mounts cannot be copied in or out with the archive API (`docker cp`). This design therefore streams the workspace in through **stdin** and artifacts out through a **framed stdout protocol**, which also keeps the provider abstraction portable (E2B, Daytona, Vercel Sandbox later).

## Goal
A reproducible, pinned, scanned runner image (Claude Code CLI, Codex CLI, sitekit, Chromium for screenshots) with a generic **supervisor**. A `SandboxProvider` port with a hardened **Docker** implementation. An **egress proxy** with a hostname allowlist and denial logging. A restricted Docker socket proxy for the worker, plus janitor cleanup. A security test suite proves the isolation properties.

## Scope
**In scope**
- **Image** `services/agent-runner/Dockerfile`, multi-stage:
  - Base `node:24-bookworm-slim` pinned by digest.
  - Tools: Claude Code CLI and OpenAI Codex CLI at pinned versions via build args (`CLAUDE_CODE_VERSION`, `CODEX_VERSION`; verify the recommended installation method for containers for each), `@bf/sitekit` single-file bundle (BF-042), Playwright Chromium + bundled fonts (for `sitekit screenshot`), `tini`, `ripgrep`, `git`, `jq`, `zstd`, `ca-certificates`.
  - Non-root user `agent` (uid/gid 10001); `HOME=/home/agent` (tmpfs at runtime); no sudo.
  - Default environment hardening:
    - disable non-essential traffic, telemetry and auto-updates for both CLIs (verify current env vars and settings, e.g. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and the auto-updater toggle);
    - `NODE_OPTIONS=--max-old-space-size=2048`.
  - Labels: OCI metadata + `bf.runner.versions` JSON.
  - CI:
    - build on changes;
    - SBOM (syft) and vulnerability scan (grype or trivy, fail on critical with a fix available);
    - push to GHCR by digest;
    - **smoke test** with the fake agent: the supervisor runs a scripted agent that edits `site.json`, and `sitekit check` passes.
- **Supervisor** (`services/agent-runner/supervisor`, TypeScript bundled; PID 1 under `tini`):
  1. Reads **framed stdin**: line 1 = `RunnerInput` JSON (Zod-validated), then a length-prefixed workspace bundle (`tar.zst`), then EOF.
     - `RunnerInput` fields: `runId`, `command` (argv array, no shell), `env` (secrets + config), `wallTimeSec`, `checkCommand` (default `sitekit check --json`), `collect` (globs), `limits` (max artifact bytes).
  2. Extracts into `/workspace` (tmpfs), rejecting path traversal and links in the archive.
  3. Emits `{ t: 'versions', … }` (node, claude, codex, sitekit, chromium).
  4. Spawns the command in its own process group, with `env` applied **only to the child** (secrets never written to disk).
  5. Forwards each stdout line as `{ t: 'engine', line }` and stderr as `{ t: 'stderr', line }` (raw; normalization to `EngineEvent` happens in the worker adapters, BF-044). Emits `{ t: 'heartbeat' }` every 10 s.
  6. Enforces wall time: SIGTERM to the group, then SIGKILL after 10 s. On SIGTERM from the outside, propagates and exits.
  7. After the child exits, runs `checkCommand` and emits `{ t: 'check', report }`.
  8. Streams collected files as `{ t: 'artifact', name, sha256, bytes, seq, data(base64 chunk ≤ 256 KB) }` up to the byte cap.
  9. Ends with `{ t: 'exit', code, reason }`.

  The frame schema lives in `@bf/contracts/runner` and is versioned (`protocol: 1`).
- **`SandboxProvider` port** (`@bf/contracts/sandbox` + `apps/api/src/modules/generation/infrastructure/sandbox/`):
  ```ts
  interface SandboxProvider {
    readonly id: 'docker' | (string & {});
    run(spec: SandboxRunSpec, input: RunnerInput, workspace: Readable, signal: AbortSignal): AsyncIterable<RunnerFrame>;
  }
  // SandboxRunSpec: image digest, cpu, memoryMb, pidsLimit, tmpfs sizes, wallTimeSec, egressProfile, labels
  ```
  The runner protocol is the contract; future providers (E2B, Daytona, Vercel Sandbox, Anthropic-managed) adapt their own upload, exec and download APIs to it.
- **DockerSandboxProvider** (Docker Engine API via `dockerode` or plain HTTP to the socket proxy):
  - Container config:
    - `User 10001:10001`, `ReadonlyRootfs: true`;
    - tmpfs `/workspace` (512 MB), `/tmp` (256 MB), `/home/agent` (128 MB), all `noexec` where possible except `/workspace` if agents need to run scripts (decide and document);
    - `CapDrop: ['ALL']`, `SecurityOpt: ['no-new-privileges:true']` (default seccomp), `PidsLimit 512`, memory 4 GB (no swap), 2 CPUs, `Init: false` (tini in image);
    - no host mounts, no Docker socket, no devices;
    - `NetworkMode: bf-sandbox`, with `HTTPS_PROXY`/`HTTP_PROXY` = egress proxy and `NO_PROXY=127.0.0.1,localhost`;
    - labels `bf.sandbox=true`, `bf.job`, `bf.attempt`, `bf.org`;
    - `AutoRemove: false` (we remove explicitly after collecting).
  - Lifecycle: create → attach (hijacked stream, stdin open, `StdinOnce`) → write input + bundle → close stdin → start → demultiplex stdout/stderr → parse frames (strict schema; malformed frames are counted and logged, never executed) → wait → remove (force). Abort calls `kill` (SIGTERM) → grace 10 s → `kill` (SIGKILL) → remove.
  - OOM and exit status mapped to typed errors (`SANDBOX_OOM`, `SANDBOX_TIMEOUT`, `SANDBOX_CRASH`, `SANDBOX_PROTOCOL_ERROR`) for the BF-039 failover policy.
  - Image pull policy: digest pinned, pre-pulled at worker start, with a health check that fails readiness if the image is missing.
- **Networks and egress**:
  - Docker network `bf-sandbox` with `internal: true` (no external route). The **egress proxy** container is attached to `bf-sandbox` and to an egress network.
  - Proxy: Stripe's smokescreen (hostname allowlist, private-IP blocking) or Squid with `CONNECT`-only to 443 + `dstdomain` ACLs. Evaluate both and document the choice.
  - Allowlist profiles in configuration: `models` (`api.anthropic.com`, `api.openai.com`, plus any host the pinned CLIs require for API-key auth; verify) and optional `assets` (approved image CDNs, off by default because workspaces already include asset previews).
  - Denied requests logged with run labels and counted (`sandbox_egress_denied_total{host}`).
  - Decision documented on inter-container traffic on `bf-sandbox`: sandboxes expose no ports. A per-run network is listed as optional hardening (flag), evaluated in BF-060.
- **Worker access to Docker**: through a **socket proxy** (e.g. `wollomatic/socket-proxy` or `tecnativa/docker-socket-proxy`) allowing only the needed endpoints (containers create/attach/start/wait/kill/delete/inspect, images inspect). The worker never mounts the raw socket. A narrow "sandbox broker" service is recorded as a hardening follow-up for BF-060.
- **Secrets**:
  - Per-run model keys are passed only inside `RunnerInput` over stdin, so they are invisible to `docker inspect` and container env metadata.
  - The supervisor redacts secret values from any frame or stderr line before emitting (exact-match and prefix patterns).
  - Where a provider supports scoped or limited keys (workspaces, projects, spend limits), the key per engine comes from configuration with the narrowest scope available (document what each provider supports).
- **Janitor**: repeatable job (every 5 minutes) removes containers labelled `bf.sandbox=true` older than `wallTimeSec + 5 min`, and reconciles with BF-039 attempts (frees sandbox slots, marks attempts failed if still running).
- **Compose**: add `egress-proxy` and `docker-socket-proxy` services and the `bf-sandbox` network to local (BF-002, profile `generation`) and prod (BF-025) compose files. Add a `pnpm runner:build` script and `pnpm runner:smoke`.
- **Metrics**: active sandboxes, run duration, exit reasons, OOM count, egress denials, frame errors.

**Out of scope**
- Engine-specific commands and stream parsing (→ BF-044), hosted sandbox providers (interface only), gVisor/Kata runtimes (documented as an option for BF-060).

## Requirements
### Functional
- A run receives the workspace, executes the given argv, and returns frames, the check report and artifacts. Timeouts, aborts, OOMs and crashes produce typed errors and always remove the container.
- Secrets never appear in `docker inspect`, logs, frames or artifacts (tests).
### Non-functional
- Sandbox start overhead (create to child spawn) < 3 s with a pre-pulled image.
- Supports 4 concurrent runs on an 8 vCPU / 16 GB host without OOM of the host (documented sizing).

## Design
```
services/agent-runner/
├── Dockerfile
├── supervisor/{main.ts, input.ts, extract.ts, spawn.ts, frames.ts, collect.ts, redact.ts}
├── fake-agent/fake-agent.mjs          # scripted agent for smoke tests
├── security-tests/{egress.sh, metadata.sh, readonly.sh, pids.sh, oom.sh, caps.sh}
└── README.md
packages/contracts/src/{runner/frames.ts, sandbox/provider.ts}
apps/api/src/modules/generation/infrastructure/sandbox/{docker-sandbox.provider.ts, frame-parser.ts,
                                                        janitor.processor.ts, errors.ts}
infra/compose/{egress-proxy/*, docker-socket-proxy/*}
```
- Patterns:
  - Ports & Adapters (`SandboxProvider`).
  - Protocol / Framing (versioned frames).
  - Supervisor process (PID 1 with tini).
  - Bulkhead (sandbox pool from BF-039).
  - Least privilege throughout.

## Implementation plan
1. Verify CLI installation methods, env toggles for telemetry/updates, and required hosts for API-key auth; pin versions.
2. Supervisor + frame contract + fake agent; unit tests for extraction safety and framing.
3. Dockerfile with SBOM/scan in CI; smoke test.
4. `DockerSandboxProvider` with lifecycle, abort, error mapping and frame parser; integration tests against a real Docker daemon (CI service; skip with a clear message when unavailable).
5. Egress proxy + networks + socket proxy in compose; allowlist profiles.
6. Janitor + metrics; security test suite; sizing doc.

## Testing
- **Unit:** frame parsing (valid, malformed, oversized), archive extraction (traversal, symlink, hardlink rejection), redaction, wall-time handling with fake timers.
- **Integration** (requires Docker; run in CI):
  - fake-agent run returns frames + `check` + `site.json` artifact;
  - abort mid-run removes the container within 15 s;
  - timeout maps to `SANDBOX_TIMEOUT`;
  - memory hog maps to `SANDBOX_OOM`;
  - janitor removes an orphaned container.
- **Security suite** (executed inside a sandbox by a test agent script; each must fail safely and be asserted):
  - HTTPS to a non-allowlisted host is denied by the proxy and logged;
  - direct TCP to Postgres/Valkey service names finds no route or resolution;
  - access to `169.254.169.254` fails;
  - writing to `/usr` and `/etc` fails (read-only);
  - a fork bomb is contained by the pids limit;
  - `capsh --print` shows no capabilities; process uid is 10001;
  - `docker inspect` of the container shows no secret values.

## Acceptance criteria
- [x] Pinned, scanned runner image with Claude Code CLI, Codex CLI, sitekit and Chromium; smoke test in CI.
- [x] Supervisor with versioned framed I/O (stdin workspace, stdout frames/artifacts), wall time, redaction.
- [x] `SandboxProvider` port + hardened `DockerSandboxProvider` with typed errors and guaranteed cleanup.
- [x] Egress allowlist proxy, internal-only sandbox network, Docker socket proxy; compose updated (local + prod).
- [x] Janitor, metrics, sizing documentation; security suite passes.

## Agent prompt
```text
Implement BF-043 (Agent runner sandbox).

Read first: AGENTS.md, docs/adr/0010 and 0014, docs/conventions/security.md (§2 secrets, §5 sandboxes),
docs/ARCHITECTURE.md §11 and §13, BF-039 (sandbox pool, reaper, failover error taxonomy), BF-042 (sitekit bundle and
check), BF-025 (prod compose). Skim BF-044 (engines will build RunnerInput commands and parse engine lines).

Rules:
- Least privilege everywhere: non-root, read-only rootfs, tmpfs, no caps, no socket, no internal network, egress
  only via allowlisting proxy. Prove each property with the security suite.
- Secrets travel only over stdin to the supervisor and only into the child env; never in container metadata, logs,
  frames or artifacts.
- Frames are a versioned contract (Zod) — parse strictly; never execute anything from frames.
- Every exit path removes the container and releases resources (abort, timeout, OOM, crash, worker restart via
  janitor).
- Verify current CLI install methods and telemetry/update env toggles; pin versions; document sources.

Verify: pnpm verify && pnpm test:int (Docker suite) && pnpm runner:smoke; attach security-suite output and the
sizing note in the PR.
```

## References
- ADR-0010 · ADR-0014 · docs/conventions/security.md §5
- Docker Engine API: https://docs.docker.com/reference/api/engine/ · Docker run security options and resource constraints: https://docs.docker.com/engine/containers/resource_constraints/ · tmpfs mounts: https://docs.docker.com/engine/storage/tmpfs/
- smokescreen (egress proxy): https://github.com/stripe/smokescreen · docker-socket-proxy: https://github.com/Tecnativa/docker-socket-proxy · tini: https://github.com/krallin/tini
