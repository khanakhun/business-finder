# ADR-0004: Drizzle ORM; `apps/api` owns writes and migrations

- Status: Accepted
- Date: 2026-10-14
- Tickets: BF-003, BF-014

## Context

We use PostGIS geometry/geography, pgvector, tsvector generated columns, ltree and partial/expression indexes. The ORM must model these without fighting us, generate reviewable SQL migrations, and give strong TypeScript types. Multiple processes touch data (API, worker, sites renderer, Python service), so ownership must be explicit.

## Decision

- **Drizzle ORM** with the `postgres.js` driver; schema in `packages/db/src/schema/*` (one file per bounded context); custom column types for `geography`, `vector`, `tsvector`, `ltree`, `citext` where not built-in.
- **Drizzle Kit** generates SQL migrations into `packages/db/migrations`; every migration is committed, human/agent-reviewed, and applied by `pnpm db:migrate` (and by a one-shot `migrate` container on deploy).
- Raw SQL is allowed (and expected) for: extension setup, generated columns, complex indexes, RLS policies, materialized views and hybrid-search queries — via `sql` template tags, never string concatenation.
- **Ownership**: only `apps/api` (HTTP + worker processes) writes. `apps/sites` connects with a read-only role and reads only publication/version tables. Python never connects.
- **Migration policy**: forward-only; destructive changes use expand → migrate data → contract across separate PRs; every migration must be safe on a populated table (no long exclusive locks: create indexes `CONCURRENTLY` in standalone migrations).
- Tests use Testcontainers with the same custom Postgres image and run all migrations once per test worker; each test runs in a transaction rolled back at the end (or truncation for multi-connection tests).

## Alternatives considered

| Option | Why not |
|---|---|
| Prisma | Excellent DX, but PostGIS/pgvector/tsvector are `Unsupported` types requiring raw SQL for most of our core queries; heavier client. |
| TypeORM / MikroORM | Decorator-heavy entities, weaker type inference, more magic. |
| Kysely only | Great query builder, but we'd hand-write schema + migrations; Drizzle gives both and is Kysely-like in queries. |
| Raw SQL only | Loses type safety at scale with agent-written code. |

## Consequences

- Positive: typed queries, SQL-like mental model, first-class Postgres features.
- Negative: Drizzle relational query API is less mature than Prisma's for deep includes; we prefer explicit joins in repositories anyway.
- Negative: generated migrations must be reviewed (Drizzle can produce destructive diffs on renames) — CI runs `drizzle-kit check`, and the PR template asks for migration review.

## References

- Drizzle ORM: https://orm.drizzle.team/docs/overview
- Drizzle + PostGIS: https://orm.drizzle.team/docs/guides/postgis-geometry-point
- Drizzle + pgvector: https://orm.drizzle.team/docs/guides/vector-similarity-search
