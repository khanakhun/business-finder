# Agent runner sizing (BF-043)

How many sandboxed engine runs (Claude Code, Codex) a host can take, and what each one costs it.

## One sandbox

| Resource | Default | Setting |
|---|---|---|
| CPU | 2 cores | `SANDBOX_CPUS` |
| Memory | 4 GB, no swap | `SANDBOX_MEMORY_MB` |
| Processes | 512 | `SANDBOX_PIDS_LIMIT` |
| `/workspace` tmpfs | 512 MB (counts against memory) | provider spec |
| `/tmp`, `/home/agent` tmpfs | 256 MB, 128 MB | provider spec |
| Wall time | the run's `wallTimeSec`; the provider stops it 60 s later | per engine (BF-044) |

A typical run uses far less than its limits: the agent CLI (Node) ~300–600 MB, Chromium for `sitekit check`
screenshots ~300 MB at peak, the workspace a few MB. Limits are ceilings, not reservations — but a host must survive
every sandbox reaching its limit at once, so plan with the limits.

## The image

`bf-agent-runner` is about 2.1 GB (Chromium and its libraries are most of it). Pull it on each worker host before
the worker starts (`docker pull <image>@sha256:…`); with `SANDBOX_ENABLED=true` the worker's `/health/ready` fails
while it is missing. Container start-up is ~1 s once the image is local.

## Host sizing

Concurrency is `GENERATION_MAX_SANDBOXES` (default 4), counted across the deployment (BF-039 leases).

| Host | Sandboxes (2 CPU / 4 GB) | Notes |
|---|---|---|
| 4 vCPU / 8 GB | 1 | Leaves room for the app stack on a single-VPS deployment. |
| 8 vCPU / 16 GB | 2 | The staging VPS shape (ADR-0014). |
| 16 vCPU / 32 GB | 4–5 | A dedicated worker host. |
| 32 vCPU / 64 GB | 10 | Lower `SANDBOX_MEMORY_MB` to 3072 to fit 12. |

Rule of thumb: `GENERATION_MAX_SANDBOXES ≤ min(floor((host CPUs − 2) / SANDBOX_CPUS), floor((host GB − 4) /
(SANDBOX_MEMORY_MB / 1024)))` — the 2 CPUs and 4 GB keep the worker, Postgres client load and the OS responsive.

## Watch

- `bf_sandbox_runs_total{outcome}` — `SANDBOX_OOM` rising means the memory limit is too tight for the engine.
- `bf_sandbox_run_seconds` — compare with the engines' wall times.
- `bf_generation_lease_waits_total` — jobs waiting for a sandbox slot: add hosts or raise the limit.
- `sandbox_egress_denied_total{host}` (egress proxy, port 9465) — an agent trying to reach something else.
- `bf_sandbox_frame_errors_total` — a runner/worker protocol mismatch (image and API out of step).

## Clean-up

The janitor (every five minutes, in the reaper) removes containers labelled `bf.sandbox=true` older than their wall
time plus five minutes — what a crashed worker left behind. Their attempts are failed over by the reaper.
