---
id: BF-027
title: Enrichment orchestration (step pipeline, website as a source, staleness, budgets)
milestone: M2 Understand
epic: enrichment
type: feature
priority: P0
size: L
depends_on: [BF-012, BF-014, BF-016, BF-020, BF-026]
blocks: [BF-028, BF-029, BF-030, BF-031]
areas: [api, worker]
---

# BF-027 — Enrichment orchestration (step pipeline, website as a source, staleness, budgets)

## Context
Enrichment adds facts to a business through ordered **steps** ([DOMAIN.md](../DOMAIN.md#1-glossary): enrichment run, site intel): `site_intel` (BF-026), `email_verify` (BF-028), `reviews` (BF-029), `psi` + `vision_audit` (BF-030). Steps have dependencies (vision needs screenshots from site intel), freshness policies, costs and rate limits. Facts found on the website must flow into the golden record with provenance — the website is simply another **source** for ingestion (BF-016). Discovery runs can request auto-enrichment (BF-020).

## Goal
A durable enrichment framework where each step is a pluggable class, runs execute as dependency-aware BullMQ flows with idempotency, staleness and budget policies, website facts are ingested as `website` source records, results are stored as snapshots, and the UI shows status and website facts.

## Scope
**In scope**
- Tables (`enrichment` context, global facts + org attribution):
  - `enrichment_runs`: `id`, `business_id`, `triggered_by_org_id`, `trigger` (`discovery|manual|bulk|schedule|event`), `requested_steps` text[], `status` (`queued|running|completed|partially_completed|failed|cancelled`), `cost_usd`, `started_at`, `finished_at`, `error`.
  - `enrichment_steps`: `id`, `run_id`, `step`, `status` (`queued|running|done|skipped|failed`), `attempt`, `input_hash`, `output_ref` jsonb, `cost_usd`, `skip_reason`, `error`, timestamps.
  - `website_snapshots`: `id`, `business_id`, `url`, `final_url`, `fetched_at`, `reachability`, `http_status`, `tls` jsonb, `security` jsonb, `languages` jsonb, `pages` jsonb, `contacts` jsonb, `socials` jsonb, `booking` jsonb, `ordering` jsonb, `chat` jsonb, `analytics` jsonb, `tech` jsonb, `freshness` jsonb, `mobile` jsonb, `performance_hints` jsonb, `no_solicitation` jsonb, `logo_candidates` jsonb, `image_candidates` jsonb, `screenshot_desktop_key`, `screenshot_mobile_key`, `content_hash`; index (`business_id`, `fetched_at desc`).
- Framework (`enrichment` module):
  - `EnrichmentStep` interface: `id`, `dependsOn[]`, `appliesTo(business, context) → boolean | SkipReason`, `freshness(lastOutput) → isStale`, `estimateCost(business)`, `execute(ctx, signal) → StepResult` (pure orchestration of ports), `costCategory` (`llm|provider|free`).
  - `StepRegistry` (later tickets register `email_verify`, `reviews`, `psi`, `vision_audit`).
  - `EnrichmentPlanner`: resolves requested steps + dependencies + freshness → DAG; skips fresh steps unless `force`.
  - Execution: BullMQ flow (parent `enrichment.run`, children per step respecting dependencies via flow tree ordering); each step job idempotent by `businessId:step:inputHash`; heartbeats; cancellation; per-step retry policies; reconciler for stuck steps.
  - Budget: per-org monthly enrichment budget (setting) using step cost estimates; LLM steps also respect `@bf/ai` budgets; PSI and verifier rate limits via token buckets.
  - Policies: freshness TTLs per step (config: site_intel 30 d, email_verify 60 d, reviews 30 d, psi 30 d, vision_audit 30 d); "no website" → skip site_intel/psi/vision with reason.
- `site_intel` step (implemented here): calls intel via `IntelClient` (create the shared adapter if not already created by BF-019: signed requests, timeouts (120 s), retries for transient errors only, circuit breaker); artifact prefix `sites/<businessId>/<runId>/`; stores `website_snapshots`; maps to a `SourceRecord(provider='website', providerRef=<host>)` with name (from JSON-LD/title), phones, emails (with `published_on_site`, page URL context), socials, address/geo/hours from JSON-LD → `IngestSourceRecordCommand` (BF-016) so facts merge with provenance; updates `business_media` logo/image candidates (as external URLs, license `owner_site`, not downloaded here).
- Triggers:
  - Subscriber on `discovery.business_found` / `business.created` when the discovery run requested `autoEnrich`.
  - `POST /v1/businesses/:id/enrich { steps?, force? }` (`business:write`, idempotency key) and `POST /v1/enrichment/bulk { businessIds[], steps? }` with estimate endpoint `POST /v1/enrichment/estimate`.
  - Scheduled refresh (repeatable, nightly): re-enrich tracked businesses with stale steps, capped per org per night.
- Events: `enrichment.run.progressed`, `business.enriched` (`{ businessId, steps: {id, status}[], changedFields[] }`) → consumed by scoring (BF-031) and search embeddings (BF-022 composer now includes website summary keywords).
- UI:
  - Business detail **Website** tab (registered via BF-024 registry): reachability, final URL, languages, contacts found (with page), socials, booking/ordering/chat/analytics chips, tech stack chips, freshness, mobile readiness, no-solicitation warning banner, screenshots (desktop/mobile) — placeholders where BF-030 adds scores/findings; "Enrich now"/"Re-run" with step selection; live step status via realtime.
  - Listing: enrichment status indicator column (icon + tooltip) and bulk action "Enrich" (registry from BF-023) with cost estimate dialog.

**Out of scope**
- Email verification, reviews, PSI and vision steps (→ BF-028, BF-029, BF-030). Scoring (→ BF-031).

## Requirements
### Functional
- Running enrichment twice without `force` skips fresh steps; with `force` re-runs them.
- Website facts appear on the golden record with provenance `website` and do not override manual values.
- A failed step does not fail independent steps; dependent steps are skipped with reason.
### Non-functional
- Throughput: ≥ 300 site-intel steps/hour per intel worker (document measured); intel outages trip the circuit breaker and runs resume later.

## Design
```
modules/enrichment/
├── domain/{enrichment-step.ts, planner.ts, freshness.ts, run-state.ts}
├── application/{commands/{enrich-business,bulk-enrich}.command.ts, queries/*, subscribers/*}
├── infrastructure/{steps/site-intel.step.ts, intel-client.ts, processors/*, repositories/*}
└── interface/http/*
apps/web/src/features/business/tabs/website.tsx (+ bulk action registration)
```
- Patterns: Strategy/Plugin (steps), DAG planning, Template Method (step execution wrapper: idempotency, metrics, cost), Adapter (IntelClient).

## Implementation plan
1. Contracts (steps, runs, snapshot DTO, events).
2. Domain: planner + freshness + run state (unit tests).
3. Tables + repositories.
4. Execution engine (flows, idempotency, cancellation, reconciler) with a fake step for tests.
5. Site-intel step + IntelClient + website source ingestion mapping.
6. Triggers, APIs, scheduled refresh, events.
7. UI (Website tab, status column, bulk enrich).

## Testing
- Unit: DAG planning with dependencies/skips; freshness; cost estimation; mapping SiteIntel → SourceRecord (snapshot).
- Integration: run with fake steps (success, failure, skip, cancel, crash recovery); site-intel step against a fake intel server (MSW) → snapshot stored + golden record updated with provenance; budget exhaustion halts; scheduled refresh caps.
- E2E: open business → Enrich now → status updates live → Website tab shows facts (fake intel in E2E env).

## Acceptance criteria
- [x] Step framework with registry, DAG planner, freshness, budgets and idempotent execution.
- [x] Site-intel step persists snapshots and ingests website facts with provenance.
- [x] Manual, bulk, discovery-triggered and scheduled enrichment work; events emitted.
- [x] Website tab and listing status indicator with live updates.

## Implementation notes (BF-027)
- **Contracts** `packages/contracts/src/enrichment.ts`: step ids, triggers, run/step statuses, skip reasons, requests
  (enrich, bulk, estimate), run/step views, `BusinessEnrichment`, `WebsiteSnapshot` (a SiteIntel subset without page
  markdown), jobs (`enrichment-run`, `enrichment-step`, `enrichment-refresh`), `business.enriched`, realtime
  `enrichment.run.progressed`, workspace `EnrichmentSettings` (monthly budget, nightly cap). `SourceRecord` gained
  optional `contactPages` (the page that shows each contact); listing items carry `enrichment` status.
- **DECISION: a DB-driven DAG, not BullMQ flows.** Steps form a DAG (vision needs site intel and reviews), which a
  flow tree cannot express without duplicating nodes, and ADR-0006 makes the database the source of truth. Step rows
  hold `depends_on`; `advance` (under the run row lock) skips steps whose dependency failed or was skipped (a `fresh`
  dependency still provides its output), enqueues ready ones and finalizes the run with `business.enriched`. Same
  pattern as discovery runs; the reconciler rebuilds lost jobs from rows.
- **Engine** (`EnrichmentOrchestrator`, Template Method around step plugins): claim (queued → running, attempt + 1,
  the claiming job id; only once every dependency in the run is terminal and any `not_before` has passed — a duplicate
  or early job is a no-op), rate limit (a token bucket per step; a wait records `not_before` and re-enqueues with a
  delay instead of holding a worker), heartbeat, execute, meter (`bf_enrichment_steps_total`,
  `bf_enrichment_step_duration_seconds`), then record the outcome and advance the run in **one transaction** under the
  run's row lock. Transient failures (incl. intel timeouts) retry 3× with backoff (30 s, 60 s, recorded as
  `not_before`); an open circuit (intel down) waits 60 s without using an attempt, so runs resume once intel is back; a
  worker shutdown hands the step on without using an attempt; permanent errors fail the step (dependents skipped,
  independent steps finish). Resilience errors reach the engine as typed `ExternalServiceError`s (`circuit_open`,
  `timeout`), never as library types. Only domain error messages are stored on step rows. Cancellation skips open
  steps and signals the job that claimed each running one. Progress is published at each claim, completion and end.
  `business.enriched` only when a step ran (also for a cancelled run whose earlier steps ran).
- **Planner** (pure): requested steps + transitive dependencies in dependency order (cycle detection); skips
  `not_registered`, `not_applicable`/`no_website`, `dependency_skipped`, `fresh` (same input hash within the step's
  TTL; a dependency that re-runs makes its dependents stale) unless `force`, and `budget` (costed steps beyond what is
  left of the workspace's monthly budget: estimates of open runs + costs of finished ones this month — read and
  reserved under a workspace-level lock, so concurrent bulk, discovery and nightly starts cannot overspend). Steps are
  plugins: `StepRegistry` (exported); `site_intel` registers through it like later steps will. A partial unique index
  backs "one open run per business and workspace"; a workspace may have at most 1 000 open runs (`busy`).
- **Site intel step**: `IntelSiteIntel` (`POST /v1/site-intel`, `intel-site` policy: 120 s, no retry, shared
  breaker) or `FakeSiteIntel` (`FAKE_SITE_INTEL`, refused in production). Artifacts under
  `sites/<businessId>/<runId>/`; snapshot in `website_snapshots` (content hash excludes timing and artifact keys);
  a readable site becomes a `website` SourceRecord → `IngestSourceRecordCommand` with `targetBusinessId` (linked to
  this business without matching; providerRef `host/businessId` so two businesses sharing a site keep their own
  source) — facts merge with provenance, manual values win; contacts keep the page they were seen on; logo and image
  candidates replace the business's website media (external URLs, license `owner_site`) through business-graph's
  `ReplaceWebsiteMediaCommand`. The name is the site's own (business-type JSON-LD, else a page title naming the same
  business); a site that redirected to another registrable domain contributes nothing. A site found unreachable is
  checked again after 2 days instead of the full TTL. Snapshots: the latest 3 per business are kept; a retried step
  does not store the same crawl twice.
- **No-solicitation (compliance)**: a statement seen by any crawl sets a sticky `no_solicitation_markers` row (first/
  last seen, page, phrases, snippet); later crawls that miss it (site down, other pages read) never clear it — only a
  person can (BF-049), and a new detection sets it again. The Website tab banner, `GET …/website`
  (`noSolicitationMarker`) and `business.enriched` (`noSolicitationDetected`) read the marker, not the latest crawl.
- **Triggers**: `POST /v1/businesses/:id/enrich` (business:write, Idempotency-Key, one open run per business and
  workspace — a second request joins it), `POST /v1/enrichment/bulk` (≤ 500, per-business outcome),
  `POST /v1/enrichment/estimate` (a few queries for the whole selection), `discovery.business.found` subscriber (runs
  with `autoEnrich`), nightly refresh (worker scheduler from `ENRICHMENT_REFRESH_HOUR_UTC` on — a worker down at that
  hour catches up later that day —, one job per UTC day; candidates have a stale output for any registered step, least
  recently enriched first, capped per workspace per day, retried days count what they started). Caller
  `Idempotency-Key`s are namespaced (`user:`), so they cannot collide with automatic runs; a key reused for another
  business is a 409. Estimate and bulk are rate limited; BullMQ priorities put interactive runs before bulk and
  nightly ones. Reads: run, business enrichment, website snapshot, screenshots
  (artifacts bucket, served as images only).
- **Events**: `business.enriched` (`changedFields` = golden fields the run changed, via ingestion); search re-embeds
  on it — the embedding text now includes the home-page description and online booking/ordering tools.
- **Web**: Website tab (BF-024 registry: enrichment panel with live step status, step selection, Enrich now / Re-run /
  Stop; no-solicitation banner; site, contacts with page links, tools, tech, languages, freshness, mobile,
  screenshots; placeholder for BF-030), "Enrich now" quick action, bulk "Enrich" with estimate dialog (BF-023
  registry), listing status icon column, realtime invalidation, EN/FR.
- **Also**: the Valkey token bucket moved to `platform/rate-limit` (shared by discovery and enrichment steps);
  `S3ObjectStorage` takes a bucket (`ARTIFACT_STORAGE`).
- **Throughput** (NFR ≥ 300 site-intel steps/hour per intel worker): not measured against real sites (no staging
  server). The engine adds a few database round trips per step (10 integration runs, fake intel, ≈ 3 s in all);
  the crawl itself is intel-bound: 2 browser contexts per intel worker (`SITE_INTEL_MAX_CONTEXTS`) at a typical
  5–15 s per site gives ≈ 500–1 400 crawls/hour. To measure on staging (follow-up).
- **Tests**: domain (planner, freshness, run state, website mapping, hours parsing), orchestrator failure paths,
  site-intel step and adapters, ingestion (`targetBusinessId`, contact pages), embedding text; integration
  (Testcontainers): DAG + provenance + media + event, fresh/force/idempotency, failure isolation, no website, cancel,
  authz (every route, roles, other workspaces, key reuse), manual values win, sticky no-solicitation marker, exact
  budget + estimate in a fresh workspace, discovery trigger, nightly cap, a dependent never runs early (reconciler),
  crash recovery; E2E: Enrich now → live status → Website
  tab (axe-clean) → contact in the golden record.
- **DECISIONS**: enrichment reads business-graph and crm tables directly (a read-only cross-module read model, as search
  does); writes go through business-graph commands. Two workspaces enriching the same business at the same time both
  crawl it (dedupe is per workspace). Facts are global, so a workspace can see that a business's website was crawled
  recently (by anyone): accepted, like the rest of the shared business graph.
- **Follow-ups**: measure throughput on staging; an object-storage lifecycle rule for `sites/` artifacts and the
  website snapshots in the DSR/retention tooling (BF-055); clearing a no-solicitation marker (BF-049); LLM steps rely on `@bf/ai` budgets (BudgetExceeded → step skipped
  `budget`); BF-028–BF-030 register their steps; BF-031 consumes `business.enriched`.

## Agent prompt
```text
Implement BF-027 (Enrichment orchestration).

Read first: AGENTS.md, docs/ARCHITECTURE.md §7–§8 (F3), docs/DOMAIN.md (enrichment terms), docs/adr/0006.
Reuse: SiteIntel endpoint (BF-026), ingestion (BF-016), discovery events (BF-020), outbox/realtime (BF-012),
detail page registries (BF-024), bulk action registry (BF-023), IntelClient if created in BF-019.

Rules:
- Steps are plugins; later tickets must add steps without touching the engine. Prove it by implementing
  site_intel through the same registry.
- The website is just another source: route its facts through IngestSourceRecordCommand, never write golden
  fields directly.
- Untrusted content (page markdown) is not stored in the DB; keep keys to object storage only.

Verify: pnpm verify && pnpm test:int && pnpm e2e.
```

## References
- docs/ARCHITECTURE.md §7–§8 · docs/DOMAIN.md · ADR-0006 · ADR-0008
- BullMQ flows: https://docs.bullmq.io/guide/flows
