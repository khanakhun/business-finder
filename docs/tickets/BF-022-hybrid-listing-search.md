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
- [x] Hybrid search endpoint with all filters, sorts and cursor pagination; org-scoped.
- [x] Facets endpoint consistent with results.
- [x] Embedding pipeline + backfill + model change handling.
- [x] Saved searches, lists, CSV export with audit logging.
- [x] p95 targets met on the 200k synthetic dataset (benchmark in PR).

## Implementation notes (BF-022)
- **Migrations and `CONCURRENTLY`**: Drizzle's migrator wraps all pending migrations in one transaction, so
  `runMigrations` (`@bf/db`, mirrored by `@bf/testing` for the template DB) now runs each migration in its own
  transaction and none for one starting with `-- bf:no-transaction` (0013–0016, one index each). A concurrent
  build that leaves an INVALID index makes the migrator refuse to record it (drop it and re-run).
- **0012 rewrites `businesses`** (stored generated `search_tsv`) and backfills `category_text` under an exclusive
  lock: fine before the first deployment (BF-025); on a populated table it needs a maintenance window.
- **Text document**: `search_tsv` = name (A) + `category_text` (B: every category's ancestors' labels EN/FR and
  synonyms, maintained by statement-level triggers on `business_categories` and on category renames/moves) +
  locality/address (C) + `short_description` (D, filled by BF-026), via `bf_tsvector` (english + french + simple,
  unaccented). Stemming limits: "coiffeurs" matches "coiffeur"/"Coiffure" through the French stemmer only when
  the stems agree; names are matched unstemmed (simple) and by trigram.
- **Listing** (`GET /v1/businesses`, moved from business-graph; `SearchModule` registers before
  `BusinessGraphModule` so `/businesses/facets` and `/export.csv` win over `/businesses/:id`): always scoped to
  the workspace's tracked businesses (ADR-0008), permanently closed excluded unless `includeClosed`. Filters are a
  Specification compiled to bound SQL. Sorts: keyset cursors on (key, id), nulls last, carrying the sort name
  (a cursor from another sort is a 422). `website=weak` behaves as `has` until audits exist (`DECISION`).
- **Relevance**: full text (`ts_rank_cd`), name word similarity (`<%`, trigram GIN) and embeddings (HNSW,
  iterative scans, `hnsw.ef_search` = `SEARCH_HNSW_EF_SEARCH`, distance ≤ `SEARCH_VECTOR_MAX_DISTANCE`, same model
  only) — ≤ 200 candidates each — fused with RRF (k = 60). The fused ranking is cached 5 min in Valkey per
  (workspace, filters, origin, recency) so relevance pages are stable. Without an embedding key/budget, ranking
  uses the two lexical rankers. Text result sets (and their counts) are capped by the candidate limits.
- **Facets**: each dimension drops its own filter; with text, the candidates are ranked without the facet
  dimensions' filters and every count applies all the other filters. One statement computes them all (one
  snapshot, one scan): matching rows with one flag per dimension filter, GROUPING SETS for the simple dimensions,
  and a category rollup through a small category → facet-prefix map. JIT is off for it (compiling cost ~0.4 s at
  200k rows, more than the query).
- **Embeddings**: `EmbeddingTextComposer` (name, category paths EN/FR, place, description, price; global facts
  only) → sha256 hash. `business.created/updated` enqueue `search/embed-business` (key
  `businessId:model:hash`) only when text or model changed; no key/budget → skipped, provider outage → retried.
  `pnpm search:reindex [--model] [--batch]` backfills resumably. Vector column is 1536-d: a model with other
  dimensions needs a migration.
- **Saved searches**: store prompt, edited intent, query-string filters (validated against the listing schema)
  and sort; private or workspace-shared, creator-only edits; `newMatches` (tracked since last run) on get/run only
  (null in lists); a run by someone else does not reset the creator's count; ≤ 500 per workspace. `notifyNew` is
  stored only (notifications are a follow-up).
- **Lists**: unique names per workspace, bulk add/remove ≤ 1,000 tracked businesses, `GET /v1/businesses?list=`.
- **CSV export**: same filters/sort, selectable columns, ≤ `SEARCH_EXPORT_MAX_ROWS` (50k), UTF-8 BOM, text cells
  starting with `= + - @` prefixed with `'`, `email` only with `outreach:send` (the public phone is exported as
  the listing shows it), one `business.exported` audit entry (row count, columns, filter keys — no values).
- **Benchmark** (200k businesses, 20k embedded, 20 rounds, local Docker, over HTTP): p95 — default 8 ms,
  category + score 90 ms, radius + rating + email 63 ms, status + tag 7 ms, 5th page 6 ms, text 8 ms (cached
  ranking) / 77 ms (uncached), facets 422 ms, facets + category 446 ms, facets + text 21 ms (88 ms uncached).
  `pnpm --filter @bf/api search:bench-seed --org <id>` fills a development workspace the same way.
- **Performance**: `pnpm --filter @bf/api bench:search` seeds BF_BENCH_BUSINESSES (200k) synthetic businesses
  (generate_series, deterministic) and times 10 request shapes over HTTP; `explain.int.test.ts` checks that the
  six main shapes can use their indexes and that sorted pages walk theirs without a Sort.
- **Follow-ups**: saved-search new-match notifications; suppression-aware export once suppressions exist (M4);
  per-route rate limits for export/search; `weak` website filter (BF-030/BF-031); merging org sort keys (tags,
  score) on business merge (BF-024).

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
