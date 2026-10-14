---
id: BF-003
title: Database foundation (Drizzle, extensions, migrations, test database)
milestone: M0 Foundations
epic: foundations
type: infra
priority: P0
size: M
depends_on: [BF-002]
blocks: [BF-006, BF-014]
areas: [db]
---

# BF-003 — Database foundation (Drizzle, extensions, migrations, test database)

## Context
PostgreSQL is the single primary datastore ([ADR-0003](../adr/0003-postgresql-as-primary-datastore.md)); Drizzle owns schema and migrations, and only `apps/api` writes ([ADR-0004](../adr/0004-drizzle-orm-and-migration-ownership.md)). The custom Postgres image and local stack exist (BF-002). Later tickets add tables per bounded context; this ticket creates the shared foundation they all use: client, migration pipeline, extensions, custom column types, transaction context, seeds and test-database utilities.

## Goal
`@bf/db` provides a typed Drizzle client, custom Postgres types (geography, vector, tsvector, ltree, citext), a transaction context usable by repositories, a reviewed migration workflow, and `@bf/testing/db` gives integration tests a real, migrated Postgres via Testcontainers.

## Scope
**In scope**
- `packages/db` (`@bf/db`):
  - `createDb({ url, max, idleTimeout, applicationName, readOnly? })` using `postgres.js` + Drizzle; statement timeout per connection (`SET statement_timeout`), application name for observability.
  - Custom column types in `src/types/`: `geographyPoint()` (`geography(Point,4326)` ⇄ `{ lat, lng }`), `geographyMultiPolygon()` (⇄ GeoJSON), `vector(dims)` (⇄ `number[]`), `tsvector()`, `ltree()` (⇄ `string`), `citext()`. Each with round-trip tests.
  - Column helpers: `id()` (uuid primary key, value supplied by app via `newId()` — BF-004 provides it; until then a local `uuidv7` import is acceptable and replaced in BF-004), `timestamps()` (`created_at`, `updated_at` default `now()`), `orgId()` (`organization_id uuid not null`).
  - Transaction context: `runInTransaction(db, fn, { isolationLevel? })` storing the transaction in `AsyncLocalStorage`; `getExecutor(db)` returns the ambient transaction or the root client; nested calls reuse the outer transaction (savepoints optional via flag).
  - Initial migration `0000_extensions_and_functions.sql`: `CREATE EXTENSION IF NOT EXISTS` postgis, vector, pg_trgm, unaccent, citext, ltree, pgcrypto; immutable wrapper `f_unaccent(text)` (for generated columns/indexes); `set_updated_at()` trigger function; helper `bf_tsvector(text_en, text_fr, simple)` if useful.
  - `drizzle.config.ts`, migrations folder `packages/db/migrations`, schema index `src/schema/index.ts` (empty barrel that later tickets extend, one file per context).
  - Seeds: `src/seed/` runner executing ordered, idempotent seed modules by environment (`dev`, `test`, `staging`); `pnpm db:seed [--only <module>]`.
  - Scripts: `db:generate --name`, `db:migrate`, `db:check` (Drizzle Kit check for drift/conflicts), `db:seed`, `db:studio`, `db:reset` (dev only: drop & migrate & seed, guarded by `NODE_ENV !== 'production'` and an explicit `--yes`).
- `packages/testing` additions (`@bf/testing/db`):
  - Vitest `globalSetup` that starts one Postgres container from the custom image (build context `infra/docker/postgres`, or `BF_TEST_PG_IMAGE` env to reuse a prebuilt image in CI), runs migrations once into a template database, and exposes connection info.
  - `createIsolatedDatabase()` — `CREATE DATABASE … TEMPLATE bf_template` per test file (fast, isolated); `withRollback(db, fn)` for per-test transactions; `truncateAll(db)` helper.
- Documentation: `packages/db/README.md` (how to add a table, naming conventions, expand/contract recipe, `CONCURRENTLY` index migrations, raw SQL guidelines).

**Out of scope**
- Domain tables (each context's ticket adds its own). Row-level security (→ BF-060). Backups (→ BF-061).

## Requirements
### Functional
- `pnpm db:migrate` applies all migrations to `DATABASE_URL`; idempotent re-run is a no-op.
- `pnpm db:check` fails if schema and migrations drift.
### Non-functional
- Integration test suite startup (container + template) < 25 s cold, < 3 s per additional test file.
- Migrations never run automatically from app startup in production (explicit migrate step).

## Design
```
packages/db/
├── drizzle.config.ts
├── migrations/0000_extensions_and_functions.sql
└── src/
    ├── client.ts            # createDb, DbClient type
    ├── tx.ts                # runInTransaction, getExecutor (AsyncLocalStorage)
    ├── types/{geography,vector,tsvector,ltree,citext}.ts
    ├── columns.ts           # id(), timestamps(), orgId()
    ├── schema/index.ts
    ├── seed/{runner.ts, modules/}
    └── index.ts
packages/testing/src/db/{global-setup.ts, isolated-db.ts, rollback.ts}
```
- Vector type: dimension is a parameter; values validated (length, finite numbers) on write.
- Geography mapping: read via `ST_AsGeoJSON` / `ST_Y`/`ST_X` in custom type `fromDriver`; write via `ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography`. Document lat/lng order explicitly (GeoJSON is lng,lat).
- Pattern: **Unit of Work** via the transaction context; repositories never accept a `tx` parameter — they call `getExecutor(db)`.

## Implementation plan
1. Verify Drizzle's current support for custom types, PostGIS and pgvector (official guides) and Testcontainers' current Node API.
2. Create `@bf/db` client, tx context, custom types, column helpers; unit tests where possible.
3. Write migration 0000 by hand (SQL), register it with Drizzle's journal correctly.
4. Implement seed runner and scripts.
5. Implement Testcontainers global setup + isolated DB + rollback helpers.
6. Integration tests: create a throwaway table in the test (not in migrations) with all custom types; round-trip values; `ST_DWithin` radius query; cosine distance ordering; ltree descendant query; unaccent FTS match (`'Café'` matches `'cafe'`).
7. Docs.

## Testing
- `types/*.test.ts`: mapping functions (driver ⇄ app), validation errors.
- `db.int.test.ts`: migrations apply; extensions present; round-trips; spatial and vector queries; nested `runInTransaction` rollback semantics (inner error rolls back everything; outer commit persists); concurrent transactions isolated.
- Performance smoke: creating an isolated database per file < 3 s.

## Acceptance criteria
- [ ] `pnpm db:migrate` on a fresh local DB succeeds; all extensions installed; `f_unaccent` and `set_updated_at` exist.
- [ ] Custom types round-trip correctly in integration tests (point, multipolygon, vector, tsvector, ltree, citext).
- [ ] `runInTransaction` + `getExecutor` give ambient transactions; tests prove rollback/commit behaviour.
- [ ] `@bf/testing/db` provides isolated databases from a migrated template; CI-friendly image override via env.
- [ ] `pnpm db:check` detects drift (demonstrated in the PR by a deliberate temporary change).
- [ ] `packages/db/README.md` documents conventions and the expand/contract recipe.

## Agent prompt
```text
Implement BF-003 (Database foundation).

Read first: AGENTS.md, docs/ARCHITECTURE.md §6, docs/adr/0003 and 0004, docs/conventions/coding-standards.md §5,
docs/conventions/testing.md §3. Read BF-002 to reuse the Postgres image and env loading (@bf/config).

Rules:
- Check current Drizzle ORM / Drizzle Kit docs for custom types, PostGIS and pgvector before coding.
- Repositories in later tickets will call getExecutor(db); design the API so they never need a tx argument.
- Keep geography lat/lng order explicit and tested — this is a classic bug source.
- Do not add domain tables. Use throwaway tables inside integration tests to exercise types.
- Testcontainers must use the same custom image as local/prod (build from infra/docker/postgres or
  BF_TEST_PG_IMAGE).

Verify: pnpm verify && pnpm test:int; pnpm infra:up && pnpm db:migrate && pnpm db:check. Paste outputs.
```

## References
- docs/ARCHITECTURE.md §6 · ADR-0003 · ADR-0004 · docs/conventions/testing.md §3
- Drizzle custom types: https://orm.drizzle.team/docs/custom-types · PostGIS guide: https://orm.drizzle.team/docs/guides/postgis-geometry-point · pgvector guide: https://orm.drizzle.team/docs/guides/vector-similarity-search
- Testcontainers for Node: https://node.testcontainers.org/
