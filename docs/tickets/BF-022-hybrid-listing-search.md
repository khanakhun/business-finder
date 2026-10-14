---
id: BF-022
title: Hybrid listing search, facets, saved searches, lists and embeddings
milestone: M1 Find & List
epic: search-listing
type: feature
priority: P0
size: L
depends_on: [BF-013, BF-014, BF-015]
blocks: [BF-023]
areas: [api, db, ai]
---

# BF-022 — Hybrid listing search, facets, saved searches, lists and embeddings

## Context
The listing combines global facts (businesses) with workspace state (`org_businesses`, later scores). Users filter by area, categories and many attributes, and also type free text ("rooftop", "vegan", "Chez …"). We implement hybrid retrieval in PostgreSQL: structured filters + full-text (accent-insensitive, FR/EN) + trigram fuzzy names + semantic vectors, fused with Reciprocal Rank Fusion ([ADR-0003](../adr/0003-postgresql-as-primary-datastore.md)). Performance target: p95 < 300 ms at 200k businesses ([PRD §7](../PRD.md#7-non-functional-requirements)).

## Goal
`GET /v1/businesses` and `GET /v1/businesses/facets` serve fast, filterable, hybrid-ranked results for a workspace, backed by a deterministic embedding pipeline, plus saved searches, lists and CSV export.

## Scope
**In scope**
- Schema additions (migrations; index creation `CONCURRENTLY` in standalone migrations):
  - `businesses.search_tsv` generated column: weighted `setweight(to_tsvector('simple', f_unaccent(display_name)), 'A')` + category labels EN/FR (denormalized `category_text` column maintained by triggers or by the repository on save) `'B'` + locality/address `'C'` + short description `'D'` (combine `french`, `english` and `simple` configs as documented); GIN index.
  - `businesses.embedding vector(1536)`, `embedding_model`, `embedding_text_hash`; HNSW index (`vector_cosine_ops`, m=16, ef_construction=64) — partial where not null.
  - `org_businesses` denormalized sort/filter keys: `score` smallint, `tier` char(1), `score_profile_id`, `last_activity_at`, `tags` text[] (GIN), `owner_user_id`; composite indexes for common sorts (`organization_id, score desc, business_id`).
- Embedding pipeline (`search` module): deterministic `EmbeddingTextComposer` (name, categories EN/FR, locality, keywords from site intel summary when available (BF-026), key attributes) → hash; `search.embed` processor subscribed to `business.created`/`business.updated` (only when the hash changes); batch embedding via `@bf/ai.embed` with batching and cost tracking; backfill CLI `pnpm search:reindex [--model]`; re-embed when the configured model changes (store model per row).
- Query engine `BusinessSearchQuery` (Specification → SQL builder with Drizzle `sql`):
  - Filters: area (`ST_Intersects(location, area.geom)` or `ST_DWithin(location, point, radius)`), categories with descendants (`categories.path <@ ANY(...)`), keywords, website (`any|none|has` now; `weak` once audits exist — leave a typed hook), rating/review ranges, hasEmail/hasPhone/emailVerified (EXISTS on contacts), pipeline statuses, tags (`&&`), owner, tiers/score range, addedWithinDays, operating status (exclude permanently closed by default), country.
  - Text relevance: FTS (`websearch_to_tsquery` with unaccent for FR & simple configs), trigram similarity on `normalized_name`, vector similarity (query embedded via `@bf/ai.embed`, cached) — each producing ranked candidate lists (limit 200) → RRF fusion (k=60) → final page; without text, sort by requested key.
  - Sorts: relevance, score, rating, reviews, distance (from area centroid or point), recent; stable cursor (sort key + id) via `@bf/contracts` cursor helpers.
  - Org scoping: only businesses tracked by the workspace (`org_businesses`) in `listings` mode.
  - `EXPLAIN`-verified index usage for the 6 most common query shapes (tests).
- Facets (`GET /v1/businesses/facets` with the same filters): counts by top-level category and selected category children, pipeline status, tier, website presence, email availability, rating band, locality (top 20) — each computed with filters excluding its own dimension (standard faceting semantics).
- Saved searches: table `saved_searches` (`id`, `organization_id`, `created_by`, `name`, `prompt`, `intent` jsonb, `filters` jsonb, `sort`, `visibility` (`private|workspace`), `notify_new` bool, `last_run_at`); CRUD APIs; "new matches since last run" count.
- Lists: `lists` (`id`, `organization_id`, `name`, `description`, `created_by`), `list_items` (`list_id`, `business_id`, `added_by`, `added_at`); CRUD + add/remove items in bulk (≤ 1,000 per call).
- CSV export: `GET /v1/businesses/export.csv?…filters` streaming (`business:read`, max 50k rows, audit-logged, fields selectable; no secrets; contacts included only if user has `outreach:send`).
- Performance harness: seed command generating 200k synthetic businesses + org links + embeddings (fake deterministic vectors) for local perf tests; benchmark script reporting p50/p95 for representative queries.

**Out of scope**
- UI (→ BF-023). Scores (→ BF-031 updates the denormalized keys). Audit-based `weak` website filter (→ BF-030/BF-031 implement the hook).

## Requirements
### Functional
- Accent-insensitive search: "cafe" finds "Café", "creperie" finds "Crêperie"; FR stemming helps ("coiffeurs" finds "Coiffure"? — document limits).
- Facet counts consistent with list results (tests).
### Non-functional
- p95 < 300 ms for typical filtered queries at 200k businesses; facets p95 < 500 ms.
- Embedding backfill resumable; costs tracked.

## Design
```
modules/search/
├── domain/{search-spec.ts, rrf.ts, embedding-text.ts}
├── application/{queries/search-businesses.query.ts, queries/facets.query.ts, commands/*saved-search*, *list*}
├── infrastructure/{sql/business-search.sql.ts, sql/facets.sql.ts, processors/embed.processor.ts, export/csv-stream.ts}
└── interface/http/{businesses-search.controller.ts, saved-searches.controller.ts, lists.controller.ts}
```
- Patterns: Specification (filters), Strategy (rankers), RRF fusion as a pure function, Iterator/stream for CSV.

## Implementation plan
1. Contracts for query params, results, facets, saved searches, lists (Zod → OpenAPI).
2. Migrations (columns, generated tsv, indexes CONCURRENTLY).
3. Embedding composer + processor + backfill CLI.
4. Query builder + RRF + cursor + facets with integration tests on a seeded dataset.
5. Saved searches, lists, export.
6. Perf seed + benchmark + EXPLAIN tests; tune indexes and `hnsw.ef_search`.

## Testing
- Unit: RRF fusion (ties, missing lists), embedding text determinism, spec → SQL fragments (snapshot of generated SQL for each filter).
- Integration: each filter; text search accent/stemming cases; semantic ordering with fake vectors; facet/list consistency; cursor stability across pages with concurrent inserts; org isolation; export streaming and permission on contacts.
- Performance: benchmark results attached; EXPLAIN tests assert index usage.

## Acceptance criteria
- [ ] Hybrid search endpoint with all filters, sorts and cursor pagination; org-scoped.
- [ ] Facets endpoint consistent with results.
- [ ] Embedding pipeline + backfill + model change handling.
- [ ] Saved searches, lists, CSV export with audit logging.
- [ ] p95 targets met on the 200k synthetic dataset (benchmark in PR).

## Agent prompt
```text
Implement BF-022 (Hybrid listing search, facets, saved searches, lists and embeddings).

Read first: AGENTS.md, docs/adr/0003, docs/ARCHITECTURE.md §6 and §8 (F1), docs/conventions/api.md §3,
docs/PRD.md §7. Reuse: business graph (BF-014), taxonomy paths + candidate search (BF-015), @bf/ai embeddings (BF-013),
outbox events (BF-012), cursor helpers (BF-004).

Rules:
- Build the synthetic 200k dataset and benchmark early; let measurements drive index choices.
- Use parameterized SQL only (Drizzle sql tag); snapshot-test generated SQL for each filter.
- Indexes on large tables are created CONCURRENTLY in standalone migrations.

Verify: pnpm verify && pnpm test:int; attach benchmark output (p50/p95 per query shape) and EXPLAIN plans.
```

## References
- ADR-0003 · docs/ARCHITECTURE.md §6, §8 · docs/conventions/api.md §3
- PostgreSQL FTS: https://www.postgresql.org/docs/current/textsearch.html · pg_trgm: https://www.postgresql.org/docs/current/pgtrgm.html · pgvector HNSW: https://github.com/pgvector/pgvector#hnsw · RRF paper: https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf
