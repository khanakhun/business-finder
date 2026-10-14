# ADR-0003: PostgreSQL (PostGIS, pgvector, FTS, JSONB) as the single primary datastore

- Status: Accepted
- Date: 2026-10-14
- Tickets: BF-003, BF-014, BF-022

## Context

We need: relational integrity (workspaces, CRM, outreach, versions), geospatial queries (within polygon, radius, tiling), semantic search (embeddings), fuzzy and accent-insensitive text search (French names!), flexible documents (provider payloads, SiteSpecs, audit findings) and transactional outbox semantics. Data volume is moderate (10⁴–10⁶ businesses). The team is small; operational simplicity matters.

## Decision

Use **PostgreSQL 17** as the single primary datastore with extensions:

| Need | Extension / feature |
|---|---|
| Geo | PostGIS (`geography` types, GiST indexes, `ST_DWithin`, `ST_Intersects`) |
| Vectors | pgvector (`vector` type, HNSW indexes, cosine distance) |
| Fuzzy text | pg_trgm (GIN trigram indexes, similarity) |
| Accent-insensitive FTS | unaccent + `tsvector` (generated columns), language configs |
| Hierarchies | ltree (category trees) |
| Case-insensitive emails | citext |
| Crypto helpers | pgcrypto (only for `gen_random_uuid` fallback/digests; app does encryption) |
| Documents | JSONB with targeted GIN indexes |

A custom image (`infra/docker/postgres/Dockerfile`) extends the official PostGIS image with pgvector so dev, CI and prod are identical. Valkey is used for queues/cache/pub-sub only — never as a source of truth.

Hybrid search is implemented in SQL: candidate sets from filters + FTS + trigram + vector similarity, fused with Reciprocal Rank Fusion (RRF). A dedicated search engine (Typesense/Meilisearch/OpenSearch) is deferred until p95 targets cannot be met.

## Alternatives considered

| Option | Why not |
|---|---|
| MongoDB | Flexible documents, but weak relational integrity and transactions across our many relationships; geo and vector exist but we'd still need relational modeling; two stores to operate. |
| MySQL | No pgvector-class vector support in the open-source edition, weaker geo and FTS for our use. |
| Postgres + Elasticsearch/OpenSearch | Excellent search, but a second stateful system with sync complexity — premature for our scale. |
| Postgres + separate vector DB (Qdrant, Pinecone) | Same sync problem; pgvector with HNSW is sufficient at our scale. |

## Consequences

- Positive: one backup, one connection pool, joins between geo/vector/relational data, transactional consistency.
- Positive: JSONB keeps provider payloads and SiteSpecs without schema churn.
- Negative: query tuning (index choice, `EXPLAIN ANALYZE`) is on us — BF-022 includes performance tests on a seeded 200k dataset.
- Negative: very large vector sets would eventually need partitioning or a specialized store; revisit at > 5M rows.

## References

- PostGIS: https://postgis.net/documentation/
- pgvector: https://github.com/pgvector/pgvector
- Reciprocal Rank Fusion: Cormack et al., SIGIR 2009
