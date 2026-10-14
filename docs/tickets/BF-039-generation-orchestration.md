---
id: BF-039
title: Generation orchestration — batches, prioritized per-engine queues, parallelism, failover, cancellation, budgets
milestone: M3 Build
epic: generation
type: feature
priority: P0
size: L
depends_on: [BF-011, BF-012, BF-013, BF-035]
blocks: [BF-040, BF-041, BF-043, BF-044, BF-045, BF-046, BF-058]
areas: [api, worker, contracts, db]
---

# BF-039 — Generation orchestration: batches, prioritized per-engine queues, parallelism, failover, cancellation, budgets

## Context
This ticket implements the user's core flow. The partner selects a salon, a hardware store and a café, clicks **Create sites**, orders them by priority (café first) and picks an engine per item (Auto, Blocks, Claude Agent SDK, Claude Code, Codex). Jobs run one by one or in parallel (e.g. 2 × Claude Code + 2 × Codex), each streaming live progress. Failures retry or fail over to another engine, and every success ends as a preview on our domain ([PRD J3](../PRD.md#5-key-user-journeys), [ADR-0010](../adr/0010-pluggable-agent-engines-in-sandboxes.md), [ADR-0006](../adr/0006-bullmq-and-db-backed-state-machines.md)).

The orchestrator is engine-agnostic. It defines the contracts and ports that other tickets plug into, so they can be built in parallel:
- `WorkspacePreparer` → BF-040 (brief, fact registry, assets).
- `AgentEngine` implementations → BF-041 (blocks), BF-044 (Claude Agent SDK, Claude Code, Codex).
- `QualityPipeline` → BF-045 (quality gates and repair loop).

This ticket ships a **FakeEngine**, a **fixture WorkspacePreparer** and a **schema-only QualityPipeline**, so the whole lifecycle is testable end to end today.

## Goal
A `generation` module with:
- batches and jobs that follow the DOMAIN §3.3 state machine;
- one BullMQ queue per engine with user priorities and live reprioritization;
- per-workspace and global concurrency (including a sandbox slot pool);
- `Auto` engine selection, retries with engine failover, cancellation, and budgets per job, batch and workspace;
- a persisted event log streamed over SSE;
- hand-off to the sites module (version + preview publish).

## Scope
**In scope**
- **Contracts** (`@bf/contracts/generation`):
  - `EngineId`, `AgentEngine`, `EngineCapabilities` (`sandboxed`, `supportsRepair`, `supportsChatEdit`, `maxParallel`, `typicalCostUsd`, `typicalDurationSec`).
  - `EngineRunContext` (`jobId`, `attempt`, `mode: 'create'|'repair'`, `workspace` (bundle ref + local path when materialized), `brief` summary, `budgetUsd`, `deadlineAt`, `locales`, `repair?` (`baseSpecRef`, `issues[]`), `logger`, `emit`).
  - `EngineEvent` union (ARCHITECTURE §11, plus `progress { pct, label }` and `heartbeat`).
  - `GenerationJobStatus` and transition table; batch/job/attempt DTOs; API request/response schemas.
  - `GenerationSettings` (per workspace): allowed engines, default engine, per-engine concurrency, failover chain, default budgets per engine, `autoPublishPreview`, default locales policy.
- **Tables** (migration):
  - `generation_batches`:
    - `id`, `organization_id`, `created_by`, `name`;
    - `status`, derived and stored: `queued|running|completed|completed_with_issues|cancelled`;
    - `settings` jsonb (resolved snapshot), `budget_usd`, `cost_usd`;
    - `counts` jsonb (per status);
    - `created_at`, `started_at`, `finished_at`.
  - `generation_jobs`:
    - `id`, `batch_id`, `organization_id`, `business_id`, `site_id?` (existing site for regenerate);
    - `position`, `priority` (1 = highest … 10), `engine_requested` (`auto|<engine>`), `engine_current`, `engine_selection_reason`;
    - `status`, `attempt_count`, `max_attempts_per_engine`, `failover_chain` (array);
    - `budget_usd`, `cost_usd`, `usage` jsonb;
    - `result_version_id?`, `published_url?`, `quality_score?`;
    - `error_code?`, `error_message?`, `cancel_requested_at?`;
    - timestamps.
  - `generation_attempts`: `id`, `job_id`, `attempt_no`, `engine`, `mode`, `status`, `sandbox_ref?`, `heartbeat_at`, `started_at`, `finished_at`, `cost_usd`, `usage`, `exit_reason`, `error` jsonb.
  - `generation_events`: `id` bigserial, `job_id`, `attempt_id`, `seq` (unique per job), `type`, `payload` jsonb, `created_at`; index (`job_id`, `seq`); retention 90 days via `system.retention`.
  - `generation_artifacts`: `id`, `job_id`, `attempt_id`, `kind` (`workspace_bundle|site_spec|screenshot|transcript|log_bundle`), `storage_key`, `sha256`, `bytes`, `created_at`. Stored in the `bf-generation` bucket (private).
- **Domain**:
  - `GenerationJob` aggregate with an explicit typed transition table (DOMAIN §3.3) and invariants (at most one running attempt; terminal states immutable except via `retry`).
  - `GenerationBatch` with derived status and counts.
  - `FailoverPolicy`:
    - error taxonomy: `retryable` (timeouts, provider 5xx, sandbox crash, invalid output once) vs `fatal` (budget exhausted, policy violation, invalid brief, cancelled);
    - per-engine attempts, then the next engine in the chain;
    - a cheaper-engine fallback when the budget would be exceeded.
  - `EngineSelectionPolicy` for `auto`, as an explainable Strategy:
    - inputs: workspace-allowed engines, engine availability/health, queue backlog and estimated wait, business complexity (page plan size, menu/services count, locales), remaining budget;
    - output: engine + reason stored on the job.
  - `BudgetPolicy`: job ≤ engine default unless overridden; batch cap; workspace monthly AI budget from BF-013 (soft warn / hard block at enqueue and start).
- **Queues and workers**:
  - Queues `generation.blocks`, `generation.claude-agent-sdk`, `generation.claude-code`, `generation.codex` (catalog §7.1), created from the engine registry. Unknown or unavailable engines are rejected at enqueue.
  - BullMQ job id = `<jobId>:<attempt>` (idempotent enqueue). User priority maps to BullMQ `priority`. Live reprioritization uses `job.changePriority`, and "Start next" sets the highest priority. Verify the current BullMQ APIs for priorities, `changePriority`, manual delays (`moveToDelayed` + `DelayedError`), stalled-job settings and graceful shutdown.
  - **Concurrency**, in four layers:
    1. Worker concurrency per queue = global max for the engine (configuration).
    2. Per-workspace per-engine limit via a Valkey lease semaphore (`gen:slots:<org>:<engine>`, TTL + heartbeat renewal). When no slot is free, the job is delayed with jittered backoff (does not count as an attempt).
    3. Global **sandbox pool** for engines with `sandboxed = true` (`GENERATION_MAX_SANDBOXES`, default 4), so 2 × Claude Code + 2 × Codex fit together while a fifth waits.
    4. Per-batch `maxParallel` (batch setting; `1` = strictly **sequential** in priority order, the default when the user picks "one by one"; empty = bounded only by layers 1–3) via lease `gen:slots:batch:<batchId>`.
  - **`GenerationProcessor`** (one class, instantiated per engine queue), running these phases:
    1. **Prepare.** Acquire leases. Transition to `preparing`. Call `WorkspacePreparer.prepare(job)`, which returns a bundle ref and summary. Store the bundle artifact.
    2. **Run.** Transition to `running`. Run `engine.run(ctx, signal)` and consume `EngineEvent`s:
       - batch-persist events (flush every 250 ms or 50 events), publish to Valkey stream `gen:job:<id>`, and update usage/cost incrementally;
       - enforce the budget (abort with `BUDGET_EXCEEDED` when exceeded) and wall time (`deadlineAt`);
       - heartbeat every 15 s.
    3. **Hand off on `done`.** Fetch and size-check the spec artifact (≤ 1 MB), transition to `validating`, and enqueue `generation.quality`.
    4. **Release** leases in `finally`.
  - **Quality hand-off** (`generation.quality` processor) calls `QualityPipeline.evaluate(job, specRef)` and acts on the result:
    - `pass`: `CreateSiteVersion` (author `generation_job`, quality attached; creates the site via `CreateSite` if needed). If `autoPublishPreview`, run `PublishPreview`. Transition to `succeeded`; the domain event `generation.job.status_changed` (DOMAIN §4) carries the preview URL.
    - `repair` (issues + repairs left; only for engines with `supportsRepair`): transition to `repairing` and enqueue a new attempt in `mode: 'repair'` with the issues and base spec on the same engine.
    - `needs_review`: create the version **without** publishing, transition to `needs_review`, and notify the user.
  - **Reaper** (repeatable, every minute): attempts whose heartbeat is older than 2 minutes become failed (retryable). Leases are released and the failover policy is applied. Covers stalled jobs.
  - **Cancellation**:
    - queued jobs are removed from the queue;
    - running jobs get a cancel message on Valkey pub/sub `gen:cancel:<jobId>`, and the worker's `AbortController` aborts the engine (engines must stop sandboxes/LLM calls within 10 s);
    - the job transitions to `cancelled`;
    - batch cancel cancels all non-terminal jobs.
- **Ports with default implementations** (replaced by later tickets via DI tokens):
  - `WorkspacePreparer` → `FixtureWorkspacePreparer`: builds a workspace from `@bf/site-schema` fixtures + business name, so the flow runs without BF-040.
  - `QualityPipeline` → `SchemaOnlyQualityPipeline`: `validateSite` (+ `validateFacts` when a registry exists in the workspace).
  - `EngineRegistry` with `FakeEngine`, enabled in dev/test via `GENERATION_FAKE_ENGINE=true`:
    - scripted events, configurable duration, cost, failure mode and invalid output;
    - returns a fixture spec personalized with the business name.
- **API** (permissions: `sites:generate`; viewing: `sites:read`):
  - `POST /v1/generation-batches`:
    - body `{ name?, items: [{ businessId, engine: 'auto'|EngineId, priority?, budgetUsd?, siteId? }], settings?: { maxParallel?, autoPublishPreview?, locales?, style?, offer? } }`;
    - `Idempotency-Key` honoured; validation: ≤ 50 items, engines allowed for the workspace, budgets within caps;
    - returns batch with jobs and the engine selection for `auto` items.
  - `GET /v1/generation-batches` (cursor; filters status/creator/date), `GET /v1/generation-batches/:id` (jobs, counts, cost, ETA estimate).
  - `PATCH /v1/generation-jobs/:id` (`priority`, `engine` while queued), `POST /v1/generation-jobs/reorder` (batch ordering → priorities).
  - `POST /v1/generation-jobs/:id/cancel`, `POST /v1/generation-batches/:id/cancel`.
  - `POST /v1/generation-jobs/:id/retry { engine? }` (terminal jobs only; new attempt).
  - `POST /v1/sites/:id/regenerate { engine, instructions? }` → single-item batch bound to an existing site.
  - `GET /v1/generation-jobs/:id` (attempts, usage, artifacts with short-lived signed URLs for screenshots).
  - `GET /v1/generation-jobs/:id/events` (SSE): replays persisted events from `Last-Event-ID`/`?after=seq`, then tails the Valkey stream; heartbeats every 15 s; closes on terminal state.
  - `GET /v1/generation/engines`: registry listing (id, label, availability, capabilities, typical cost/duration, current queue depth and running count for this workspace and globally).
- **Realtime and notifications**:
  - Every state transition emits the domain event `generation.job.status_changed` through the outbox (DOMAIN §4). In addition, throttled realtime messages `generation.job.updated` (status, progress, cost; ≤ 2/s per job) and `generation.batch.updated` go to the org channel; these are UI notifications, not domain events.
  - Notification on batch completion and on `needs_review` (BF-012).
- **Observability**:
  - Metrics: `generation_jobs_total{engine,outcome}`, phase duration histograms, queue wait time, cost per job histogram, active sandboxes gauge, lease-wait count.
  - One trace per job with spans per phase (attempt id in attributes); logs carry `jobId`/`attemptId`.

**Out of scope**
- Real engines (→ BF-041, BF-044), brief/facts/assets (→ BF-040, BF-038), quality gates and repair content (→ BF-045), sandbox runtime (→ BF-043), UI (→ BF-046).

## Requirements
### Functional
- A batch of N items creates N jobs ordered by priority; the highest-priority runnable job always starts first when a slot frees (within an engine queue).
- Parallelism respects all four layers (engine max, workspace limit, sandbox pool, batch `maxParallel`) under load; proven by an integration test with FakeEngine (e.g. limits 2/2/3: never more than 3 sandboxed jobs concurrently; a batch with `maxParallel = 1` runs strictly one at a time in priority order).
- A retryable failure retries on the same engine up to N times, then fails over along the chain; a fatal failure stops immediately with a typed error.
- Cancellation stops a running engine within 10 s and leaves no running sandbox or lease behind.
- Events are never lost or duplicated in the persisted log; SSE resumes from the last seen sequence.
### Non-functional
- Orchestration overhead per job (excluding engine time) < 2 s.
- Worker restarts (deploys) resume or retry jobs safely (graceful shutdown waits ≤ 30 s then lets the reaper recover).

## Design
```
packages/contracts/src/generation/{engine.ts, events.ts, job.ts, settings.ts, api.ts}
apps/api/src/modules/generation/
├── domain/{generation-job.ts, job-state-machine.ts, generation-batch.ts, failover-policy.ts,
│           engine-selection-policy.ts, budget-policy.ts, errors.ts}
├── application/
│   ├── commands/{create-batch.ts, cancel-job.ts, cancel-batch.ts, retry-job.ts, reprioritize.ts, regenerate-site.ts}
│   ├── queries/{get-batch.ts, list-batches.ts, get-job.ts, list-engines.ts}
│   └── ports/{workspace-preparer.port.ts, quality-pipeline.port.ts, engine-registry.port.ts, lease.port.ts}
├── infrastructure/
│   ├── queues/{generation.processor.ts, quality.processor.ts, reaper.processor.ts, queue-factory.ts}
│   ├── leases/valkey-lease.semaphore.ts
│   ├── events/{event-writer.ts (batched), event-stream.ts (Valkey streams)}
│   ├── engines/{engine-registry.ts, fake.engine.ts}
│   ├── defaults/{fixture-workspace-preparer.ts, schema-only-quality.pipeline.ts}
│   └── repositories/*
└── interface/http/{batches.controller.ts, jobs.controller.ts, job-events.sse.ts, engines.controller.ts}
```
- Patterns:
  - State Machine (job lifecycle).
  - Strategy (engine selection, failover, budget).
  - Factory/Registry (engines, queues).
  - Template Method (`GenerationProcessor` phases).
  - Ports & Adapters (preparer/quality/engines).
  - Semaphore/Lease (concurrency).
  - Observer (event stream).
  - Transactional Outbox (domain events).
- Priority semantics: UI priority 1 (highest) … 10 maps to BullMQ priority 1 … 10 (BullMQ: lower = higher). Ties are broken by `position` (FIFO within the batch), encoded as a fractional suffix, or by enqueuing in position order.

## Implementation plan
Two PRs recommended: (1) contracts, tables, domain, API, FakeEngine and the happy path; (2) concurrency layers, failover, cancellation, reaper, SSE replay and load tests.
1. Verify the BullMQ APIs used (priorities, `changePriority`, delays, stalled handling, graceful close) and pin the version.
2. Contracts, migration and repositories; the domain state machine and policies (TDD, 100% transition coverage).
3. Batch creation API with idempotency and auto engine selection; queue factory per engine.
4. `GenerationProcessor` phases with FakeEngine, batched event writer and stream, quality hand-off with the sites module.
5. Lease semaphores (workspace and sandbox pool) with heartbeats; reaper.
6. Failover, retry, cancel and reprioritize; SSE endpoint with replay.
7. Realtime, notifications, metrics and traces; load and chaos tests.

## Testing
- **Unit:**
  - every allowed and forbidden state transition;
  - failover decisions per error class;
  - auto selection with load and availability inputs;
  - budget checks;
  - priority mapping and tie-breaking.
- **Integration** (Testcontainers Postgres + Valkey, FakeEngine):
  - happy path to `succeeded` with a preview publication and URL;
  - `needs_review` path creates an unpublished version;
  - repair path: two attempts, the second in repair mode;
  - concurrency limits never exceeded (instrumented counter), with 20 jobs across 3 engines;
  - priority order respected and reprioritization effective while queued;
  - cancel queued and running jobs (abort observed, leases released);
  - worker crash mid-run (kill the worker) → reaper → retry → success;
  - SSE replay: no gaps or duplicates after reconnect with `Last-Event-ID`;
  - idempotent batch creation;
  - authorization: other org gets 404, viewer cannot create.
- **Load:** 50-job batch with FakeEngine at realistic durations; orchestration overhead and event-write throughput recorded in the PR.

## Acceptance criteria
- [ ] Contracts for engines, events, jobs, settings and APIs in `@bf/contracts`.
- [ ] Batches/jobs/attempts/events/artifacts persisted; the DOMAIN §3.3 state machine is enforced.
- [ ] Per-engine queues with priority and live reprioritization; four-layer concurrency including the sandbox pool and sequential/parallel batches.
- [ ] Auto engine selection (explained), retries with failover, budgets (job/batch/workspace), cancellation within 10 s.
- [ ] Ports for preparer/quality/engines with working defaults (fixture preparer, schema-only quality, FakeEngine).
- [ ] SSE event stream with replay; realtime updates; notifications; metrics and traces.
- [ ] Integration, crash-recovery and load tests pass.

## Agent prompt
```text
Implement BF-039 (Generation orchestration).

Read first: AGENTS.md, docs/adr/0006 and 0010, docs/ARCHITECTURE.md §7 (queues), §8 F4, §11, docs/DOMAIN.md §2
(GenerationBatch) and §3.3 (job state machine), docs/conventions/api.md (idempotency, SSE). Reuse: BF-012 outbox/
realtime/notifications, BF-013 budgets and cost ledger, BF-011 workspace settings, BF-035 site commands.
Skim BF-040, BF-041, BF-043, BF-044, BF-045 and BF-046 — they implement the ports you define here; keep the
contracts minimal, typed and stable.

Rules:
- Verify current BullMQ APIs before coding (priorities, changePriority, DelayedError/moveToDelayed, stalled jobs).
- The state machine is the single authority on job status; no ad-hoc status writes.
- Concurrency limits must hold under concurrency (prove with an instrumented integration test), and leases must be
  released on every exit path including crashes (reaper).
- Events are append-only with a per-job sequence; SSE must support resume without gaps or duplicates.
- Ship FakeEngine + fixture preparer + schema-only quality so the full flow is testable now.

Verify: pnpm verify && pnpm test:int; attach the load-test summary (overhead per job, max concurrency observed).
```

## References
- ADR-0006 · ADR-0010 · docs/ARCHITECTURE.md §7, §8 F4, §11 · docs/DOMAIN.md §3.3
- BullMQ docs (priorities, flows, rate limiting, delayed jobs): https://docs.bullmq.io/ · Valkey streams: https://valkey.io/topics/streams-intro/
