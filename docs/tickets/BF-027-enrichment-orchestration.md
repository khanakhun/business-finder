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
- [ ] Step framework with registry, DAG planner, freshness, budgets and idempotent execution.
- [ ] Site-intel step persists snapshots and ingests website facts with provenance.
- [ ] Manual, bulk, discovery-triggered and scheduled enrichment work; events emitted.
- [ ] Website tab and listing status indicator with live updates.

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
