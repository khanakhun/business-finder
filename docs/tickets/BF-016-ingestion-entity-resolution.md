---
id: BF-016
title: Ingestion pipeline and entity resolution (golden records with provenance)
milestone: M1 Find & List
epic: business-graph
type: feature
priority: P0
size: L
depends_on: [BF-012, BF-014, BF-015]
blocks: [BF-018, BF-020, BF-024, BF-027]
areas: [api, worker, db]
---

# BF-016 — Ingestion pipeline and entity resolution (golden records with provenance)

## Context
The same café can appear in Google Places, Overture, Foursquare, OSM and on its own website, with slightly different names, phones and coordinates. Discovery (BF-020) and enrichment (BF-027) feed **source records**; this ticket turns them into one deduplicated **golden record** per real business with field-level provenance ([DOMAIN.md](../DOMAIN.md#1-glossary): entity resolution, provenance). Tables and value objects exist (BF-014); the classifier exists (BF-015); events go through the outbox (BF-012).

## Goal
`IngestSourceRecordCommand` idempotently normalizes a source record, finds candidate matches, scores them, and either merges into an existing golden record (applying survivorship rules), creates a new one, or flags a possible duplicate — safely under concurrency — with manual merge/unmerge tools.

## Scope
**In scope**
- Contract `SourceRecordSchema` (in `@bf/contracts`): `provider`, `providerRef`, `fetchedAt`, `expiresAt?`, `name`, `providerCategories: {key,label?}[]`, `location {lat,lng}`, `address` components, `phones[]`, `website?`, `emails[]`, `socials[]`, `hours?`, `rating?`, `reviewCount?`, `priceLevel?`, `operatingStatus?`, `attributes?`, `raw` (unknown, stored in payload).
- Pipeline (Chain of Responsibility; each stage a pure-ish class with tests):
  1. **Normalize**: value objects from BF-014 (name, phones, URL, emails, address); classify categories (BF-015).
  2. **Persist source**: upsert `business_sources` by (`provider`, `provider_ref`) with `content_hash`; unchanged hash → only `last_seen` touch and stop (idempotency).
  3. **Block** (candidate generation): already linked source ref → that business; same E.164 phone; same website host (or registrable domain when the host is not a shared platform); within 75 m **and** name trigram similarity ≥ 0.35; same normalized name within 500 m; cap 25 candidates.
  4. **Score** each candidate (weighted, explainable): name similarity (Jaro–Winkler on normalized names + token set ratio), distance decay, phone equality, website equality, category compatibility (same/ancestor/sibling), address token overlap, provider-ref history. Output `MatchScore { total, features, reasons }`.
  5. **Decide**: ≥ 0.85 → match; 0.60–0.85 → create new + `possible_duplicates` row; < 0.60 → create new. Thresholds in config; per-provider adjustments allowed.
  6. **Merge** into golden record via survivorship rules: per-field source priority (config table, e.g. `phone: [manual, website, google_places, foursquare, overture, osm, gmaps_scraper]`), confidence and recency tie-breaks; never overwrite `manual` values; contacts unioned with provenance; categories merged with confidences; provenance map updated.
  7. **Emit** `business.created` / `business.updated` (changed fields) / `business.merged` via outbox.
- Concurrency: `pg_advisory_xact_lock` on hashed blocking keys (phone, host, geohash6+name prefix) acquired in deterministic order to prevent duplicate creation by parallel ingestions; whole pipeline in one transaction per record (batches of records processed sequentially per job).
- `IngestBatchCommand` (used by discovery) processing pages of records with per-record error isolation and metrics (`created`, `merged`, `possible_dupes`, `unchanged`, `failed`).
- Manual tools (`business:write`):
  - `POST /v1/businesses/merge { survivorId, mergedIds[] }` → re-point sources, contacts, categories, media, reviews, `org_businesses` (merging per-org states: keep the most advanced pipeline status, union tags, etc.), mark merged records (`merged_into_id`), emit `business.merged`.
  - `POST /v1/businesses/:id/split { sourceIds[] }` → create a new golden record from the given sources (unmerge), recompute both.
  - `GET /v1/businesses/possible-duplicates?status=open` and `PATCH …/:id` (dismiss/merge).
- Survivorship config: `packages/contracts/src/business-graph/survivorship.ts` (typed, documented).
- Observability: span per stage; metrics per decision; debug log with reasons for possible duplicates.

**Out of scope**
- Provider fetching (→ BF-018/BF-019), orchestration (→ BF-020), UI for duplicates (→ BF-024 shows banner/dialog).

## Requirements
### Functional
- Ingesting the same record twice yields identical state (idempotent).
- Ingesting A then B yields the same golden values as B then A, given the deterministic survivorship rules (order independence, except recency tie-breaks which are fixed by `observedAt`).
- Merge then split restores the original separation (round trip).
### Non-functional
- Throughput ≥ 1,000 records/minute on one worker with the full index set (benchmark in PR).
- No duplicate golden records when 4 workers ingest overlapping batches concurrently (stress test).

## Design
```
modules/business-graph/
├── domain/resolution/{normalizer.ts, blocking.ts, match-scorer.ts, decision.ts, survivorship.ts}
├── application/commands/{ingest-source-record.command.ts, ingest-batch.command.ts, merge-businesses.command.ts,
│                          split-business.command.ts}
├── infrastructure/{candidate.queries.ts, advisory-locks.ts}
└── interface/http/{merge.controller.ts, duplicates.controller.ts}
```
- Name similarity utilities implemented locally (Jaro–Winkler + token set) with tests, or a small well-maintained library — document choice.
- All thresholds/weights in config with defaults; scorer returns feature contributions for explainability (shown later in the duplicates UI).

## Implementation plan
1. Contracts + survivorship config.
2. Domain stages with unit tests (TDD), including tricky FR names ("Chez Joe" vs "Chez Jo's", "Le Tamarin" vs "Tamarin Restaurant").
3. Candidate queries + advisory locks (integration tests).
4. Commands + events; batch command with error isolation.
5. Merge/split commands + APIs.
6. Property-based tests (fast-check) for idempotency/order independence; concurrency stress test; benchmark.

## Testing
- Unit: each stage; scorer feature contributions; decision thresholds; survivorship (manual never overwritten, priority order, ties).
- Property-based: idempotency, order independence, merge/split round trip.
- Integration: overlapping concurrent ingestion (4 parallel workers × same records) → no duplicates; possible-duplicate creation; events emitted.
- Benchmark script with synthetic records (factories) reporting records/minute.

## Acceptance criteria
- [ ] Ingestion pipeline with normalize → persist → block → score → decide → merge → emit.
- [ ] Idempotent, order-independent, concurrency-safe (property and stress tests).
- [ ] Possible duplicates recorded with explainable scores; merge/split APIs work and re-point all references.
- [ ] Throughput target met (benchmark in PR).
- [ ] `docs/DOMAIN.md` updated if resolution concepts changed.

## Agent prompt
```text
Implement BF-016 (Ingestion pipeline and entity resolution).

Read first: AGENTS.md, docs/DOMAIN.md (business, source record, provenance, entity resolution), docs/ARCHITECTURE.md
§6.2, docs/adr/0008 and 0013. Reuse: tables & value objects (BF-014), CategoryClassifier (BF-015), outbox (BF-012).

Rules:
- This is correctness-critical data engineering. Write property-based tests (fast-check) for idempotency, order
  independence and merge/split round trips before optimizing.
- Concurrency: prove with a stress test that parallel ingestion cannot create duplicates (advisory locks).
- Never let a lower-priority source overwrite a manual value. Keep every decision explainable (feature
  contributions + reasons).

Verify: pnpm verify && pnpm test:int; run the benchmark and paste records/minute.
```

## References
- docs/DOMAIN.md · docs/ARCHITECTURE.md §6.2 · ADR-0008 · ADR-0013
- Fellegi–Sunter record linkage overview: https://en.wikipedia.org/wiki/Record_linkage · fast-check: https://fast-check.dev/ · PostgreSQL advisory locks: https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS
