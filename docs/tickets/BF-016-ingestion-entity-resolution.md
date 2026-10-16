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
- [x] Ingestion pipeline with normalize → persist → block → score → decide → merge → emit.
- [x] Idempotent, order-independent, concurrency-safe (property and stress tests).
- [x] Possible duplicates recorded with explainable scores; merge/split APIs work and re-point all references.
- [x] Throughput target met (benchmark in PR).
- [x] `docs/DOMAIN.md` updated if resolution concepts changed.

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

## Implementation notes
- **Split**: part 1/3 contracts + pure resolution domain (normalizer, blocking, scorer, decision, survivorship,
  geohash, Jaro–Winkler/token-set implemented locally); part 2/3 pipeline (ingest record/batch commands, advisory
  locks, golden writer, manual add through ingestion, `RESOLUTION_*` thresholds); part 3/3 merge/split/duplicates
  APIs, review fixes, migration 0008 (duplicates status index).
- **Golden record = f(set of sources)**: `computeGolden` picks each field by survivorship (manual → per-field
  provider priority → confidence → recency → provider ref), unions contacts, aggregates category classifications;
  every change recomputes from all linked sources (`business_sources.normalized`), which gives order independence
  and makes split a recompute. Contacts no source backs any more are removed (manual contacts stay).
- **Pipeline**: parse (422 on invalid) → content hash (record minus fetch times + normalizer version + default
  region; unchanged → touch `fetched_at`, no LLM) → classify (BF-015, before the transaction) → normalize → one
  transaction: lock → re-check → upsert source → known source? recompute : block → score → decide → create / link +
  recompute / flag possible duplicates → events. Payload stored without NUL characters, capped at 256 KB.
- **Lock protocol** (ingestion, merge, split): phase 1 blocking keys — phones, site match key, geohash6 cell + 8
  neighbours (whole cells, so name variants collide), normalized name — sorted in one statement; phase 2
  `business:<id>` keys, sorted. Ingestion follows merges after locking a business; merge/split lock the blocking
  keys of every source involved. Cell-level locks serialize ingestion within an area (correctness over parallelism).
- **Scoring**: additive, explainable (`MatchScore.features` + reasons): name 0.40 × similarity, distance 0.25 ×
  decay (1 ≤ 25 m → 0 at 500 m), phone 0.30, website 0.25, category 0.10 × compatibility, address 0.05 × overlap;
  conflicts −0.10 (phone, website), another record of the same provider −0.20. Match ≥ 0.85, possible ≥ 0.60
  (`gmaps_scraper` +0.05).
- **Manual adds** (`POST /v1/businesses`) are ingested as `manual` source records (values validated first, LLM
  classification skipped) and may only join a record the workspace alone tracks; otherwise they create their own
  record (flagged as a possible duplicate) — manual values win survivorship and must not rewrite facts other
  workspaces rely on (ADR-0008).
- **Merge/split** (`POST /v1/businesses/merge`, `POST /:id/split`, `GET|PATCH /possible-duplicates`): only on
  businesses the workspace tracks, and refused (403 `BUSINESS_SHARED`) when another workspace tracks one, unless a
  platform operator acts. Merge moves sources, contacts (manual protection kept), media, reviews, workspace links
  (most advanced pipeline status, do-not-contact kept) and open duplicate pairs; merged records become read-only and
  emit `business.merged`; per-id audit. Split creates a record from the chosen sources, copies workspace links and
  recomputes both (round trip tested).
- **Known limitations** (QUESTIONS.md): a chain where only a third record links two others can end as a possible
  duplicate in some orders (no automatic transitive merge); a known source whose content moves to another place is
  recomputed in place, not re-linked (use split); classifications are refreshed only when content or normalizer
  version changes.
- **Benchmark** (`pnpm --filter @bf/api bench:ingest`, 1,200 synthetic records, one worker, mapping-based
  classification): 3,341 records/minute (target ≥ 1,000).
- **Reviews** (fixed): lock coverage (cells without prefix + name), ingestion business locks + merge following,
  merge/split blocking locks, shared-record guard, manual-add scope, per-source attribution of manual contacts,
  `linked_by` preserved, manual contact protection on merge, versioned content hash, payload sanitising, logs without
  PII, duplicates index, per-id merge audit.
- **Tests**: domain 33 (incl. fast-check order independence, bounds, geohash neighbourhoods); use cases 21; API
  integration: resolution 9 (idempotency, cross-provider merge, manual precedence, possible duplicate, 6-order
  independence, batch isolation, 4-worker stress, concurrent name variants), merge 6.
