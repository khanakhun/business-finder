---
id: BF-002
title: Local infrastructure (Docker Compose) and environment configuration
milestone: M0 Foundations
epic: foundations
type: infra
priority: P0
size: M
depends_on: [BF-001]
blocks: [BF-003, BF-008, BF-025, BF-043]
areas: [infra, config]
---

# BF-002 — Local infrastructure (Docker Compose) and environment configuration

## Context
All services depend on PostgreSQL (with PostGIS + pgvector), Valkey, S3-compatible storage and a mail catcher; some features need the self-hosted Maps scraper and Reacher verifier. Agents work in parallel git worktrees, so several stacks must run side by side without port or volume collisions ([git-workflow.md](../conventions/git-workflow.md#parallel-agents-with-worktrees)). Every environment variable must be declared and validated in one place ([ARCHITECTURE.md §17](../ARCHITECTURE.md#17-configuration--feature-flags)).

## Goal
`pnpm infra:up` starts a healthy local stack identical in versions to production, and `@bf/config` validates environment variables for every app with clear error reports.

## Scope
**In scope**
- `infra/docker/postgres/Dockerfile`: official PostGIS image for PostgreSQL 17 (PostGIS 3.5 — verify the current tag) + pgvector installed from the PostgreSQL apt repository (or built from source pinned to a release). Init script `infra/docker/postgres/init/00-roles.sql` creating the read-only role `bf_sites_ro` (password from env) and default privileges notes. Healthcheck.
- `infra/compose/docker-compose.yml` with services and healthchecks:
  - `postgres` (custom image, named volume),
  - `valkey` (Valkey 8, AOF on),
  - `minio` + one-shot `minio-init` (creates buckets `bf-assets`, `bf-artifacts`, `bf-sites`; sets versioning on `bf-assets`),
  - `mailpit` (SMTP 1025, UI 8025),
  - profile `scraper`: `gmaps-scraper` (`gosom/google-maps-scraper`, web/REST mode with a data volume),
  - profile `verify`: `reacher` (`reacherhq/backend`),
  - profile `observability`: `otel-collector` + `jaeger` (UI) — config in `infra/compose/otel-collector.yaml` (BF-005 consumes it).
- Port/namespace isolation: `scripts/infra.mjs` (`up|down|reset|logs|ps|status`) reads `.env`, applies `BF_PORT_OFFSET` (default 0; use multiples of 10 up to 70 so stacks never collide) to base ports (pg 5432, valkey 6379, minio 9000/9001, mailpit 1025/8025, scraper 8080, reacher 8081, jaeger 16686, otlp 4318) and to the app dev ports (web 3000, sites 3100, api 4000, intel 8000, exported as `WEB_PORT`, `SITES_PORT`, `API_PORT`, `INTEL_PORT` for `pnpm dev`), sets `COMPOSE_PROJECT_NAME` (default `bf`), exports `BF_*_PORT` variables for compose, waits for healthchecks, and writes `.env.generated` with derived URLs (`DATABASE_URL`, `VALKEY_URL`, `S3_ENDPOINT`, `SMTP_URL`, …).
- `packages/config` (`@bf/config`):
  - `loadEnv(schema, { files: ['.env', '.env.generated'] })` — loads dotenv files (without overriding real env), validates with Zod, prints a grouped, human-readable report of missing/invalid vars (never printing secret values), and returns a typed, frozen object.
  - Schemas composed from fragments: `coreEnv` (NODE_ENV, LOG_LEVEL, APP_URL, API_URL, SITES_BASE_DOMAIN), `dbEnv`, `valkeyEnv`, `s3Env`, `aiEnv` (ANTHROPIC_API_KEY, OPENAI_API_KEY, model overrides), `authEnv`, `mailEnv`, `intelEnv`, `featureFlagsEnv`; per-app schemas `apiEnv`, `workerEnv`, `webEnv` (public vars prefixed `NEXT_PUBLIC_` only), `sitesEnv`.
  - Each variable has `.describe()`; secrets marked with a `secret()` helper so reports/redaction know them.
  - `pnpm env:check [app]` prints the report for an app; `pnpm env:doc` regenerates the variables table in `docs/ENVIRONMENT.md` from the schemas (CI checks it is up to date).
- `.env.example` generated from the schemas (`pnpm env:example`) with grouped comments; checked into git.
- Root scripts: `infra:up`, `infra:down`, `infra:reset` (removes volumes after confirmation flag `--yes`), `infra:logs`, `infra:status`, `env:check`, `env:doc`, `env:example`.

**Out of scope**
- Migrations and DB schema (→ BF-003). Production compose and Caddy (→ BF-025). Langfuse self-hosting (documented as optional; use Langfuse Cloud or add later in BF-061).

## Requirements
### Functional
- `pnpm infra:up` brings all default services to healthy within 90 s on a warm machine; profiles via `pnpm infra:up --profile scraper --profile verify`.
- Two checkouts with different `COMPOSE_PROJECT_NAME`/`BF_PORT_OFFSET` run simultaneously.
- Apps that start with an invalid env exit with code 1 and a readable report.
### Non-functional
- No secrets in `.env.example`; defaults only for local, non-secret values.
- Images pinned to explicit versions (digest pinning is done in BF-061 for production).

## Design
```
infra/
├── docker/postgres/{Dockerfile, init/00-roles.sql}
└── compose/{docker-compose.yml, otel-collector.yaml}
scripts/infra.mjs
packages/config/src/
├── index.ts                 # loadEnv, secret(), types
├── fragments/{core,db,valkey,s3,ai,auth,mail,intel,features}.ts
├── apps/{api,worker,web,sites}.ts
└── cli/{check,doc,example}.ts
docs/ENVIRONMENT.md          # generated table: name, app(s), required, default, secret, description
```
- `loadEnv` precedence: real environment > `.env.generated` > `.env` > schema defaults.
- Feature flags fragment: `FEATURE_MAPS_SCRAPER` (default false), `FEATURE_CODING_ENGINES` (default true), `FEATURE_AUTO_SEND` (default false) — booleans parsed strictly (`true|false|1|0`).

## Implementation plan
1. Build and test the Postgres image (`CREATE EXTENSION postgis; CREATE EXTENSION vector;` succeed in a scratch DB).
2. Write compose with healthchecks and profiles; MinIO init job.
3. Implement `scripts/infra.mjs` (Node, no deps beyond `dotenv`), including offset logic and `.env.generated`.
4. Implement `@bf/config` with unit tests; CLIs for check/doc/example; generate `.env.example` and `docs/ENVIRONMENT.md`.
5. Document in README and `docs/ENVIRONMENT.md` (how to add a variable).

## Testing
- Unit (`@bf/config`): missing required var → report lists it; invalid URL → report; secret values never appear in output (snapshot of report with a fake secret asserts absence); booleans parse strictly; precedence order.
- Script test: `infra.mjs` port computation with offsets (pure function tested).
- Manual (documented in PR): `pnpm infra:up` healthy; `docker compose ps`; extension availability query; MinIO buckets listed; Mailpit UI reachable; second stack with `BF_PORT_OFFSET=10` up concurrently.

## Acceptance criteria
- [x] `pnpm infra:up` → postgres, valkey, minio, mailpit healthy; `minio-init` exits 0 and buckets exist.
- [x] `SELECT name FROM pg_available_extensions WHERE name IN ('postgis','vector','pg_trgm','unaccent','ltree','citext')` returns all six.
- [x] `bf_sites_ro` role exists and cannot write.
- [x] Profiles `scraper`, `verify`, `observability` start their services when requested.
- [x] Parallel stacks with different offsets work.
- [x] `pnpm env:check api` prints a clear report; `.env.example` and `docs/ENVIRONMENT.md` are generated and committed.

## Agent prompt
```text
Implement BF-002 (Local infrastructure and environment configuration).

Read first: AGENTS.md, docs/ARCHITECTURE.md §3 and §17, docs/adr/0003 and 0014, docs/conventions/git-workflow.md
(worktrees section), docs/conventions/security.md §2.

Rules:
- Verify current image tags (postgis/postgis for PG 17, valkey, minio, mailpit, gosom/google-maps-scraper,
  reacherhq/backend, otel collector, jaeger) on their registries; pin explicit versions.
- pgvector must be installed in the same image as PostGIS; prove it by creating both extensions in the PR.
- @bf/config must never print secret values; treat any variable marked secret() as redacted everywhere.
- Keep scripts dependency-light (Node built-ins + dotenv).

Deliver: the image, compose file with profiles and healthchecks, scripts/infra.mjs, @bf/config with CLIs,
generated .env.example and docs/ENVIRONMENT.md, README updates.

Verify: pnpm verify; pnpm infra:up && pnpm infra:status; run a second stack with BF_PORT_OFFSET=10 and a
different COMPOSE_PROJECT_NAME; paste the outputs in the PR.
```

## References
- docs/ARCHITECTURE.md §3, §15, §17 · ADR-0003 · ADR-0014
- PostGIS Docker: https://hub.docker.com/r/postgis/postgis · pgvector install: https://github.com/pgvector/pgvector#installation
- gosom scraper: https://github.com/gosom/google-maps-scraper · Reacher: https://github.com/reacherhq/check-if-email-exists

## Implementation notes
- **Images** (all pinned): `postgis/postgis:17-3.5-alpine` + pgvector **0.8.7** built from a SHA-256-checked
  source tarball (`OPTFLAGS=""` for portable binaries) · `valkey/valkey:8.1.10-alpine` (AOF) ·
  `rustfs/rustfs:1.0.1` · `amazon/aws-cli:2.38.1` (bucket init) · `axllent/mailpit:v1.31.5` ·
  `gosom/google-maps-scraper:v1.18.1` · `reacherhq/backend:v0.11.9` · `otel/opentelemetry-collector-contrib:0.162.0`
  · `jaegertracing/jaeger:2.22.0`.
- **MinIO → RustFS.** MinIO no longer publishes community images (`minio/minio`, `quay.io/minio/minio` are gone).
  RustFS is S3-compatible (Apache-2.0), same ports, supports bucket versioning. Services are named `s3` / `s3-init`.
- **Alpine + source-built pgvector.** The Debian `17-3.5` tag is still on bullseye whose PGDG apt repo was retired.
- **`00-roles.sh`, not `.sql`**: the read-only password comes from the environment. `bf_sites_ro` has
  `default_transaction_read_only=on` *and* only SELECT grants (+ default privileges for future tables).
- **No dotenv dependency**: Node 24's `util.parseEnv` parses `.env` files in both `infra.mjs` and `@bf/config`.
- **Ports bind to 127.0.0.1.** `infra:up` pre-checks ports and suggests a `BF_PORT_OFFSET` on conflict; it waits
  for healthchecks (`--wait`) and for `s3-init` to exit 0. Scraper and OTel collector images have no HTTP client,
  so they have no healthcheck (waited on as "running").
- **`OTEL_EXPORTER_OTLP_ENDPOINT`** is written only when the `observability` profile is started.
- **`intel` app schema** added so the Python service's variables (e.g. `INTEL_PORT`) are declared too (BF-008 mirrors it).
- Generated-file freshness is enforced by `@bf/config` tests (with a package `turbo.json` adding the root files as
  inputs), so `pnpm verify` fails when `docs/ENVIRONMENT.md` / `.env.example` are stale; `--check` flags exist for CI.
- Biome boundary rule tightened: `../../apps/**`-style patterns instead of `**/apps/**`, which matched
  `@bf/config`'s own `src/apps/` folder.
