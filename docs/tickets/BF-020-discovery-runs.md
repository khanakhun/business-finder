---
id: BF-020
title: Discovery runs orchestration (adaptive tiling, budgets, progress, cancellation)
milestone: M1 Find & List
epic: discovery
type: feature
priority: P0
size: L
depends_on: [BF-012, BF-016, BF-018]
blocks: [BF-023, BF-027]
areas: [api, worker]
---

# BF-020 — Discovery runs orchestration (adaptive tiling, budgets, progress, cancellation)

## Context
A discovery run takes a search intent (categories × area) and turns it into provider queries, ingests the results, tracks the businesses for the workspace, and optionally kicks off enrichment. Runs must be estimable (cost/tiles) before starting, bounded by a budget, cancellable, resumable after crashes, and stream progress to the UI ([ARCHITECTURE.md §8 F2](../ARCHITECTURE.md#f2--discovery-run), [DOMAIN.md §3.2](../DOMAIN.md#32-discovery-run)). Providers (BF-018/BF-019), ingestion (BF-016), tiling (BF-017) and realtime/outbox (BF-012) exist.

## Goal
`POST /v1/discovery-runs` (after an optional estimate) executes a durable, adaptive, budget-capped fan-out across providers and tiles, ingests and tracks businesses, emits progress in real time, and finishes with accurate counts and costs.

## Scope
**In scope**
- Tables:
  - `discovery_runs`: `id`, `organization_id`, `created_by`, `intent` jsonb (categories, keywords, filters snapshot), `area_id`, `area_geometry` geography, `providers` text[], `options` jsonb (`autoEnrich`, `maxResults`, `fieldTier`, `tileStrategy`), `status` (DOMAIN.md §3.2), `budget_usd`, `cost_usd`, `counts` jsonb (`tasksTotal`, `tasksDone`, `tasksFailed`, `recordsFetched`, `created`, `merged`, `unchanged`, `possibleDuplicates`), `error`, `started_at`, `finished_at`, timestamps.
  - `discovery_tasks`: `id`, `run_id`, `provider`, `category_id`, `tile` jsonb, `depth` (quadtree level), `page_token`, `status` (`queued|running|done|failed|skipped`), `attempt`, `records`, `cost_usd`, `heartbeat_at`, `error`, timestamps; index (`run_id`, `status`).
- Domain: `DiscoveryRun` aggregate with state machine and invariants (cost never exceeds budget: tasks reserve estimated cost before calling; actual cost reconciled after), `DiscoveryPlanner` (Strategy per provider capability):
  - initial tiles from area geometry (`tileAsCircles` for radius-capable providers, `tileAsBBoxes` for bbox ones) sized per provider (`maxResultsPerQuery`, density hint);
  - **adaptive quadtree**: when a tile returns the provider's max results (saturated), split into 4 children (up to max depth) to avoid missing businesses in dense areas;
  - category fan-out: one task per (provider, category-key, tile); keyword-only intents use text queries.
- Application:
  - `EstimateDiscoveryRunQuery` → tiles count, tasks, estimated calls & cost per provider (min/expected/max given saturation uncertainty), expected results range, warnings (e.g. "Google Enterprise fields selected: $35/1k calls").
  - `StartDiscoveryRunCommand` (`discovery:run`, idempotency key) → persists run + root tasks, enqueues parent flow.
  - Processors: `discovery.plan` (expand tasks), `discovery.fetch` (provider page fetch with signal + budget reservation; saturated → enqueue children; next page → enqueue continuation), `discovery.ingest` (batch → `IngestBatchCommand` (BF-016), then `TrackBusinessCommand` for each affected business with `added_via=discovery`, `added_ref=runId`), completion detection (when no tasks remain) → status + `discovery.run.completed` event.
  - `CancelDiscoveryRunCommand` → cancel flag; in-flight tasks stop at next checkpoint; status `cancelled`.
  - Reconciler (repeatable): tasks `running` with stale `heartbeat_at` → requeue (attempt+1) or fail after max attempts; runs with no active tasks but non-terminal status → finalize.
  - Auto-enrich: if `options.autoEnrich`, emit `discovery.business_found` events (or call enrichment API once BF-027 exists — via event subscription defined there; this ticket only emits).
- Realtime: throttled (≤ 1/s per run) `discovery.run.progressed` events with counts; final `discovery.run.completed`; notification `discovery_completed` (BF-012 registry).
- APIs: `POST /v1/discovery-runs/estimate`, `POST /v1/discovery-runs`, `GET /v1/discovery-runs` (cursor), `GET /v1/discovery-runs/:id`, `GET /v1/discovery-runs/:id/tasks` (debug, admin), `POST /v1/discovery-runs/:id/cancel`, `GET /v1/discovery-runs/:id/businesses` (cursor; summary rows).
- Budgets: per-run `budget_usd` (default from workspace setting, e.g. $5), workspace monthly provider budget (from usage meter, BF-018) — hard stop with status `partially_completed` and reason.

**Out of scope**
- UI (→ BF-023). Enrichment execution (→ BF-027).

## Requirements
### Functional
- A run over the BL island for 3 categories with the fake provider completes with correct counts; saturated tiles split.
- Budget reached → no new provider calls; run ends `partially_completed` with `reason=budget`.
- Cancel stops new calls within one task duration; final state consistent.
- Killing the worker mid-run and restarting completes the run without duplicate ingestion (idempotent tasks + ingestion).
### Non-functional
- Progress events throttled; DB writes batched (counts updated with atomic increments).
- ≥ 1,000 businesses ingested/hour on one worker with the fake provider (benchmark).

## Design
```
modules/discovery/
├── domain/{discovery-run.ts, run-state-machine.ts, planner/{planner.ts, quadtree.ts, strategies/*}, budget.ts}
├── application/{commands/start-run.command.ts, commands/cancel-run.command.ts, queries/estimate-run.query.ts, …}
├── infrastructure/{processors/{plan,fetch,ingest}.processor.ts, reconciler.ts, repositories/*}
└── interface/http/discovery-runs.controller.ts
```
- Patterns: Aggregate + State Machine, Strategy (planning per provider), Composite (quadtree tiles), Saga-like orchestration with compensations limited to marking states (no external rollback needed).

## Implementation plan
1. Contracts (run, task, estimate, counts, events).
2. Domain: state machine, planner + quadtree, budget reservation (unit tests TDD).
3. Tables + repositories + atomic counters.
4. Processors + flow wiring + idempotency + cancellation + heartbeats.
5. Reconciler + crash-recovery integration test.
6. Estimate + APIs + realtime + notifications.
7. Benchmark with fake provider.

## Testing
- Unit: planner tile counts for BL and an urban PC4; quadtree split on saturation; budget reservation/reconciliation math; state machine transitions.
- Integration: full run with fake provider (counts, events); budget stop; cancel; worker crash recovery (close worker mid-flow, restart, verify completion and no duplicates); cross-org isolation of runs.
- E2E (in BF-023).

## Acceptance criteria
- [x] Estimate endpoint returns tiles, calls and cost ranges per provider.
- [x] Runs execute with adaptive tiling, ingestion and tracking; counts and costs accurate.
- [x] Budget caps enforced; cancellation and crash recovery work (tests).
- [x] Realtime progress + completion notification.
- [x] Benchmark meets throughput target.

## Implementation notes (BF-020)
- **Database-driven orchestration (ADR-0006)** instead of BullMQ flows: three queues (`discovery-plan`,
  `discovery-fetch`, `discovery-ingest`) execute steps whose state lives in `discovery_runs`/`discovery_tasks`.
  Fan-in is a locked `finalize` (no open task, no pending ingest, run planned) attempted after every step and by
  the reconciler. Counters are integer columns with atomic increments (not a `counts` jsonb); the page token
  lives in the task's `query` jsonb; fetched records wait on the task (`pending_records`) for the ingest job.
- **Idempotency**: tasks are unique per (run, dedupe key = provider, category, keys, mode, keywords, tile,
  page); a task's completion and its follow-ups (quadtree children, next page) commit in one transaction;
  ingestion runs once per task (`ingested_at`); job ids are `taskId:attempt` (+ a reconcile-window suffix for
  reconciler re-enqueues, so a job that failed for good does not block its retry).
- **Budget**: a call starts only after reserving its estimated cost on the run *and* the task
  (`cost + reserved + estimate <= budget`); every task exit (done, failed, requeued, skipped) gives the
  reservation back, so a crashed worker cannot leak budget. The run's `cost_usd` is the actual cost reported
  by the provider (the same cost model as the estimate). Budget stop → queued tasks skipped, in-flight calls
  finish, run ends `partially_completed` with `reason=budget` (or `monthly_budget` from the BF-018 guard).
- **Cancellation**: queued tasks skipped in the cancel transaction; in-flight jobs get a cooperative abort; a
  call that still completes is recorded as skipped with its cost, and its records are dropped.
- **Crash recovery**: running tasks heartbeat every 30 s; the reconciler (worker, every 30 s) requeues tasks
  silent for 2 min (failed after 3 attempts), re-enqueues queued tasks whose job was lost, re-runs pending
  ingests, re-plans runs whose planning never committed, and finalizes finished runs.
- **Limits**: area ≤ 25,000 km²; ≤ 20,000 tasks per run (checked from the tiling before queries are built;
  past it during a run, saturated tiles stay unsplit); ≤ 3 queued/running runs per workspace (advisory lock);
  an `Idempotency-Key` reused with a different request → 409 `IDEMPOTENCY_KEY_REUSED`.
- **Planner**: capped providers (Google, scraper) get 1.5 km circles splitting up to depth 3 (4 circles of
  0.75 r per split, children outside the area dropped); exhaustive providers (open data) get 10 km boxes.
- **Benchmark** (`pnpm --filter @bf/api bench:discovery`, synthetic fake provider, one worker, local infra):
  **2,147 businesses, 482 tasks, 7,200 records in 22.4 s → ≈ 344,000 businesses/hour** (target 1,000).
- **Follow-ups**: per-route rate limiting for estimate/start (no throttler exists yet); `maxResults` is a soft
  cap (may overshoot by in-flight fetches); a crash between ingestion and its counter update re-ingests as
  `unchanged`, so `created` can under-count; jobs re-enqueued by the reconciler are not reached by cooperative
  cancel (their results are still discarded); progress events show run cost to every workspace member.

## Agent prompt
```text
Implement BF-020 (Discovery runs orchestration).

Read first: AGENTS.md, docs/ARCHITECTURE.md §7–§8 (F2), docs/DOMAIN.md §2–§3.2, docs/adr/0006.
Reuse: providers + usage meter (BF-018/BF-019), tiling (BF-017), ingestion + track command (BF-016/BF-014),
outbox/realtime/notifications (BF-012), typed queue processors (BF-006).

Rules:
- The database is the source of truth for run/task state; queues are only the execution mechanism.
- Every processor is idempotent and cancellable; write the crash-recovery test early.
- Never exceed a budget: reserve before calling, reconcile after; test edge cases (last task straddling the cap).

Verify: pnpm verify && pnpm test:int; benchmark output in the PR.
```

## References
- docs/ARCHITECTURE.md §7–§8 · docs/DOMAIN.md §3.2 · ADR-0006 · ADR-0013
- BullMQ flows: https://docs.bullmq.io/guide/flows
