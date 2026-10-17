# Agent runner (BF-043)

The sandbox image generation agents run in. One run = one container: the worker writes the run's input and its
workspace on stdin, the supervisor answers with frames on stdout, and the container is removed.

## Protocol (`@bf/contracts/runner`, `protocol: 1`)

stdin:

1. one line of JSON — `RunnerInput`: `runId`, `command` (argv, no shell), `env` (applied to the child only),
   `secrets` (names in `env`, redacted everywhere), `wallTimeSec`, `checkCommand` (default `sitekit check --json`),
   `collect` (workspace globs to send back), `limits`;
2. one line — the workspace bundle's length in bytes;
3. the bundle (`tar.zst`, BF-040's deterministic workspace), then EOF.

stdout, one JSON frame per line: `versions` → `engine` / `stderr` lines (and a `heartbeat` every 10 s) → `check`
(the check command's JSON report) → `artifact` chunks (base64, ≤ 256 KB each) → `exit` (`completed`, `failed`,
`timeout`, `killed`, `input_invalid`, `workspace_invalid`, `internal`).

The supervisor unpacks the bundle into `/workspace` refusing links, devices, absolute paths and `..`; runs the
command in its own process group; on wall time sends SIGTERM to the group, then SIGKILL after 10 s; redacts the
run's secrets and anything shaped like a provider key from every line; runs the check without the secrets.

## Image

- Base: `node:24.13.1-trixie-slim` pinned by digest (the API image's base).
- Claude Code CLI and Codex CLI pinned by build args (`CLAUDE_CODE_VERSION`, `CODEX_VERSION`), installed with npm;
  updates, telemetry, error reports and non-essential traffic off (Claude Code environment variables; Codex
  `check_for_update_on_startup = false`, seeded into the tmpfs `HOME` at start).
- sitekit (BF-042) bundle at `/opt/sitekit` with Playwright's Chromium; `sitekit` on the `PATH`.
- tini (PID 1), ripgrep, git, jq, zstd; user `agent` (10001:10001), no sudo; labels with `bf.runner.versions`.

Run it the way the Docker provider does (read-only root, tmpfs `/workspace`, `/tmp` and `/home/agent`, no
capabilities, `no-new-privileges`, pids/memory/CPU limits; see `scripts/smoke.ts`).

## Commands

- `pnpm runner:build` — `docker build -f services/agent-runner/Dockerfile -t bf-agent-runner:dev .`
- `pnpm runner:smoke [image]` — the fake agent edits a fixture site through sitekit in a hardened container
  (`--network none`), and `sitekit check` must say done. The workspace goes in on stdin: no bind mount.
- `pnpm --filter @bf/agent-runner test` — the supervisor with real processes (frames, redaction, wall time,
  abort, artifacts, bundle safety, stdin framing).

- `pnpm egress:build` + `pnpm runner:security` — the security suite (18 checks on real containers): non-root,
  read-only root, `noexec` workspace, no capabilities, no new privileges, process limit, no network by default, no
  direct route out of the sandbox network, the egress proxy's refusals (other hosts, IP literals/metadata) and its
  allowlisted path, the socket proxy's allowed and refused calls.

CI (`runner` job): build, SBOM (syft), vulnerability scan (grype, fails on a critical with a fix available), smoke,
the security suite and the Docker provider's tests. Sizing: `docs/runbooks/agent-runner-sizing.md`.
On `main`, the image is published to GHCR by digest with the other images.
