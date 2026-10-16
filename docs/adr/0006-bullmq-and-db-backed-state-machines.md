# ADR-0006: BullMQ + DB-backed state machines for async work (Temporal deferred)

- Status: Accepted
- Date: 2026-10-14
- Tickets: BF-006, BF-012, BF-020, BF-027, BF-039, BF-053

## Context

Async workloads: discovery fan-out (minutes), enrichment pipelines (per business, minutes), site generation (2–20 minutes, expensive, must respect per-engine parallelism and priorities, cancellable), email sending (rate-limited per mailbox), sequences (waits of days), reply sync and periodic maintenance. We need priorities, concurrency limits, retries with backoff, cancellation, progress, and durable business-time scheduling.

## Decision

- **BullMQ on Valkey** for job execution:
  - one queue per job family; generation has **one queue per engine** so each engine's concurrency is a worker setting;
  - BullMQ **priorities** for user-set batch priority; **flows** for fan-out/fan-in;
  - rate limiting via BullMQ limiters (per queue) and Valkey token buckets (per provider key / mailbox / recipient domain);
  - retries with exponential backoff + jitter; `UnrecoverableError` for permanent failures;
  - every handler idempotent (idempotency key per job; side effects check-before-write);
  - Bull Board mounted in the API at `/admin/queues` for owners/admins.
- **The database is the source of truth for lifecycles.** Each long-lived process (discovery run, enrichment run, generation job, outbound message, sequence enrollment) is a row with an explicit state machine (see DOMAIN.md §3). Jobs move rows between states; if Valkey is lost, a reconciler re-enqueues work from DB state.
- **Business-time scheduling** (sequence steps, preview expiry, retention) uses `next_run_at` columns and a one-minute tick that claims rows with `SELECT … FOR UPDATE SKIP LOCKED`.
- **Transactional outbox** (`outbox_events`) bridges DB transactions and queues; relay uses `LISTEN/NOTIFY` for low latency plus a polling fallback.
- **Cancellation**: jobs check an `AbortSignal` tied to a Valkey cancel key; sandboxed agent containers are killed by the worker on cancel.

## Amendment (BF-027, 2026-10-16)

Enrichment runs do **not** use BullMQ flows. Their steps form a DAG (a step may need several others; vision needs site
intel and reviews), which a flow tree cannot express without duplicating nodes. Step rows carry `depends_on`; under the
run's row lock the engine skips steps whose dependency failed, enqueues the ready ones (a step is only claimed once its
dependencies are terminal) and finalizes the run. This is the same DB-as-truth pattern as discovery runs, and the
reconciler rebuilds lost jobs from the rows. Flows remain an option where the tree is genuinely known up front.

## Alternatives considered

| Option | Why not (now) |
|---|---|
| Temporal | Best-in-class durable execution (timers, signals, visibility), ideal for sequences and agent runs. Deferred because it adds a stateful cluster to operate and determinism constraints that raise the bar for agent-written code. Revisit if workflows become deeply nested or we need cross-language orchestration. |
| Inngest / Trigger.dev | Good DX; self-hosting adds services; vendor-shaped APIs. |
| pg-boss / Graphile Worker (Postgres-only queues) | Fewer moving parts, but weaker priorities/concurrency controls and dashboards than BullMQ; Valkey is needed anyway for rate limits and pub/sub. |
| Celery (Python) | Wrong language for most of our workers. |

## Consequences

- Positive: mature, fast, well-known; priorities and per-queue concurrency map directly to "2 jobs with Claude Code, 2 with Codex".
- Positive: DB-as-truth makes the system recoverable and auditable.
- Negative: we implement reconciliation and outbox ourselves (BF-012); covered by integration tests that kill workers mid-job.

## References

- BullMQ: https://docs.bullmq.io/
- Transactional outbox: https://microservices.io/patterns/data/transactional-outbox.html
