---
id: BF-006
title: NestJS API and worker skeleton with hexagonal module template
milestone: M0 Foundations
epic: foundations
type: feature
priority: P0
size: L
depends_on: [BF-003, BF-004, BF-005]
blocks: [BF-007, BF-010, BF-012, BF-014, BF-025, BF-035]
areas: [api, worker]
---

# BF-006 — NestJS API and worker skeleton with hexagonal module template

## Context
The backend is a NestJS modular monolith with two process types (HTTP and worker) and hexagonal modules ([ADR-0005](../adr/0005-nestjs-modular-monolith.md), [ARCHITECTURE.md §5](../ARCHITECTURE.md#5-backend-architecture-appsapi)). Async work uses BullMQ with DB-backed lifecycles ([ADR-0006](../adr/0006-bullmq-and-db-backed-state-machines.md)). Available now: `@bf/db` (client, tx context), `@bf/contracts` (errors, problem schema, jobs), `@bf/observability`, `@bf/config`. Every later backend ticket copies the patterns established here, so this ticket also delivers a **reference module** and a **module generator**.

## Goal
`apps/api` boots as an HTTP server and as a worker, with validation, problem+json errors, request context, logging/tracing, health checks, OpenAPI generation, rate limiting, BullMQ wiring with Bull Board, graceful shutdown, a reference module demonstrating every layer and a job, and a generator that scaffolds new modules consistently.

## Scope
**In scope**
- NestJS 11 app in `apps/api` with entrypoints:
  - `src/main.ts` — HTTP (Express adapter), `AppModule.forHttp()`; global prefix for REST `/v1` (Better Auth's `/api/auth/*` is added in BF-010).
  - `src/worker.ts` — `NestFactory.createApplicationContext(AppModule.forWorker())`; registers processors only; exposes metrics on a separate port.
  - `src/openapi.ts` — builds the OpenAPI document **without connecting** to DB/Valkey (modules must not connect on import; connections are lazy or provided via factories that are skipped in `openapi` mode) and writes `packages/api-client/openapi.json` (BF-007 consumes it).
- `modules/platform` (shared kernel):
  - `ConfigModule` wrapping `@bf/config` (`apiEnv`/`workerEnv`), `DbModule` (provides `DbClient`), `ClockModule` (`Clock` token → `SystemClock`), `ValkeyModule` (single connection factory, used by throttler, cache, BullMQ).
  - `RequestContextMiddleware` (requestId from header or generated, trace id) storing context in ALS + log context.
  - Global `ZodValidationPipe` (schemas from `@bf/contracts`), response serialization interceptor validating outgoing DTOs in dev/test.
  - Global `ProblemDetailsFilter`: `DomainError` → mapped status/problem; Zod errors → 422 with `errors[]`; unknown → 500 without internals; logs at the right level with error codes.
  - `@Transactional()` method decorator using `runInTransaction` from `@bf/db`.
  - Resilience helpers: `withResilience(policyName)` decorator for adapter methods using `cockatiel` (timeout, retry with exponential backoff + jitter, circuit breaker) with named policies from config.
  - Security: helmet, CORS (app origin from config), `@nestjs/throttler` with Valkey storage (default 300 req/min/user, 60/min/IP for anonymous).
  - Health: `@nestjs/terminus` `/health/live` and `/health/ready` (DB `SELECT 1`, Valkey `PING`), metrics `/metrics` (from `@bf/observability`).
  - OpenAPI: generate from Zod schemas (choose a library that supports Zod v4 and NestJS, e.g. `nestjs-zod` or `zod-openapi` + custom decorator; verify current status) — every controller documents request/response schemas and error responses; served at `/docs` (Scalar or Swagger UI) in non-production.
- BullMQ: `@nestjs/bullmq` root config from `@bf/config`; `@bf/queue` package with a typed `QueueRegistry` (queue name constants, job schemas from `@bf/contracts/jobs`, default job options) and `TypedProducer<J>` helper that validates payloads and injects trace context; base `TypedProcessor` class that validates payloads, extracts trace context, sets log context, enforces idempotency via a Valkey `SET NX` guard with TTL, supports cancellation via an `AbortSignal` bound to a cancel key, and reports progress.
- Bull Board mounted at `/admin/queues` behind a temporary HTTP basic-auth guard (credentials from env; replaced by RBAC in BF-010).
- Reference module `modules/system`:
  - `GET /v1/system/info` → `{ name, version, commit, env, time }` (query use case, Clock injected).
  - `POST /v1/system/ping-jobs` → enqueues `system.ping` job (command use case) returning 202 + job id; worker processor writes a log line, records a metric, and is idempotent by key.
  - Domain/application/infrastructure/interface folders populated minimally to serve as a living template.
- Module generator: `pnpm gen:module <context>` (plop or a small custom script) creating the folder structure, module file, `index.ts`, a sample command/query, repository port + Drizzle adapter stub, controller, processor stub, and test files from templates.
- Testing harness: Vitest with SWC transform for decorators (`unplugin-swc`), `createTestApp()` helper using `@nestjs/testing` + isolated DB from `@bf/testing/db` + Valkey Testcontainer; Supertest for HTTP.

**Out of scope**
- Auth and permissions (→ BF-010; until then all `/v1` routes are open in dev only and the app refuses to start in production without auth — enforce with a config assertion). Outbox/event bus (→ BF-012). Domain modules.

## Requirements
### Functional
- HTTP and worker start with valid env; both shut down gracefully on SIGTERM (HTTP stops accepting, in-flight requests finish within 10 s; worker stops fetching and waits for active jobs up to a configurable timeout).
- Validation error on `POST /v1/system/ping-jobs` with an invalid body returns 422 problem+json.
- OpenAPI generation works offline (no infra running).
### Non-functional
- Cold start < 3 s; p95 for `/v1/system/info` < 10 ms locally.
- No module performs I/O at import time.

## Design
```
apps/api/src/
├── main.ts / worker.ts / openapi.ts
├── app.module.ts                  # forHttp(), forWorker(), forOpenApi()
├── modules/
│   ├── platform/                  # config, db, valkey, clock, context, errors, validation, resilience, health, metrics
│   └── system/                    # reference module (domain/application/infrastructure/interface)
└── test/create-test-app.ts
packages/queue/src/{registry.ts, producer.ts, processor.ts, idempotency.ts, cancellation.ts}
tools/generators/module/           # templates for pnpm gen:module
```
- Patterns: Ports & Adapters, CQRS-lite (`*.command.ts`/`*.query.ts`), Decorator (resilience, transactional), Template Method (`TypedProcessor.process()` → `handle()`).
- `AppModule.forHttp()` imports controllers + producers; `forWorker()` imports processors + schedulers; shared module providers in both.

## Implementation plan
1. Verify NestJS 11 + Vitest/SWC setup, `@nestjs/bullmq`, terminus, throttler with Valkey storage, and the Zod-v4-compatible OpenAPI approach.
2. Platform module pieces with unit tests (filter mapping, pipe, decorators).
3. `@bf/queue` with typed producer/processor and tests against a Valkey container (idempotency, cancellation, trace propagation).
4. Reference `system` module end-to-end + tests.
5. Entrypoints, graceful shutdown, Bull Board, `/docs`, `openapi.ts`.
6. Module generator + a test that generates a module into a temp dir and typechecks it.
7. `apps/api/README.md`: architecture tour, how to add a module/job/endpoint.

## Testing
- Unit: problem filter mappings (DomainError subclasses, Zod, unknown), resilience decorator (retry counts, breaker opens), transactional decorator.
- Integration: `GET /v1/system/info`; `POST /v1/system/ping-jobs` → job processed by an in-test worker; same idempotency key twice → processed once; cancellation stops a long fake job; health endpoints reflect DB/Valkey state (stop container → ready=503).
- Contract: generated OpenAPI snapshot includes `system` routes and `ProblemDetails` component.

## Acceptance criteria
- [x] `pnpm --filter @bf/api dev` runs HTTP (4000) and worker processes; `/health/ready` is 200 with infra up.
- [x] Problem+json returned for validation, domain and unknown errors (tests).
- [x] `system.ping` job demonstrates typed producer/processor, idempotency, trace propagation and metrics (tests).
- [x] `pnpm api:openapi` writes `packages/api-client/openapi.json` without infra running.
- [x] Bull Board available at `/admin/queues` behind basic auth.
- [x] `pnpm gen:module example` scaffolds a compiling module with tests (generated test module removed before merge).
- [x] Graceful shutdown verified by an integration test or documented manual test.

## Agent prompt
```text
Implement BF-006 (NestJS API and worker skeleton with hexagonal module template).

Read first: AGENTS.md (§6 especially), docs/ARCHITECTURE.md §5 and §7, docs/adr/0005 and 0006,
docs/conventions/api.md, docs/conventions/coding-standards.md §2, docs/conventions/testing.md §3–§4.
Reuse: @bf/db (BF-003), @bf/contracts (BF-004), @bf/observability (BF-005), @bf/config (BF-002).

Rules:
- This ticket sets the template every backend ticket will copy. Favour clarity and consistency over cleverness;
  keep the reference module small but complete across all four layers.
- Verify the current way to (a) run Vitest with NestJS decorators (SWC), (b) generate OpenAPI from Zod v4 in
  NestJS, (c) use the throttler with a Redis-compatible store, before coding. Note versions in the PR.
- No I/O at import time; openapi.ts must run without Postgres/Valkey.
- Production guard: refuse to boot with NODE_ENV=production until auth exists (BF-010 removes the guard).

Split suggestion (stacked PRs): part 1 platform module + system module + HTTP; part 2 @bf/queue + worker +
Bull Board; part 3 generator + docs.

Verify: pnpm verify && pnpm test:int; pnpm infra:up && pnpm --filter @bf/api dev, curl /v1/system/info,
POST /v1/system/ping-jobs, view the trace in Jaeger (observability profile). Paste outputs.
```

## References
- docs/ARCHITECTURE.md §5, §7 · ADR-0005 · ADR-0006 · docs/conventions/api.md · docs/conventions/testing.md
- NestJS: https://docs.nestjs.com/ · @nestjs/bullmq: https://docs.nestjs.com/techniques/queues · cockatiel: https://github.com/connor4312/cockatiel · Bull Board: https://github.com/felixmosh/bull-board

## Implementation notes
Delivered as three stacked commits (platform + system + OpenAPI · queue + worker + Bull Board · generator + docs).

- **Versions**: NestJS 12.1.3 (ESM-only; ADR says ≥ 11), @nestjs/swagger 12.0.2, terminus 12.1.0, throttler 6.7.1,
  @nestjs/bullmq 12.0.0, bullmq 6.3.15, ioredis 6.0.0, cockatiel 4.0.0, helmet 8.3.0, express 5.3.0, Bull Board 9.10.4,
  @swc-node/register 1.12.1, unplugin-swc 2.0.0.
- **Runtime: SWC loader**. Node type stripping and esbuild cannot emit decorator metadata (Nest DI by type), so dev
  and tests compile with SWC. Production bundling is BF-025. Cold start under the dev loader: 3.4 s (it compiles every
  file); `GET /v1/system/info` p95 1.5 ms, `/health/live` p95 1.2 ms locally.
- **OpenAPI without nestjs-zod** (it only supports Nest ≤ 11): `zodDto(schema)` classes + a global `ZodValidationPipe`
  for validation; `@ApiRoute({ body, query, response, errors })` emits @nestjs/swagger metadata with `$ref`s to Zod
  JSON Schema components; the document is OpenAPI **3.1** (JSON Schema 2020-12). Generation runs offline (2 s).
- **Throttler storage written in-house** (`@nest-lab/throttler-storage-redis` only supports Nest ≤ 11): atomic Lua
  on Valkey. DECISION: **fails open** when Valkey is down (requests allowed, warning logged, readiness reports it).
- **Fix found in BF-007's e2e runs**: failing open still made each request wait ~10 s while ioredis reconnected
  (commands queue offline; only the first request failed fast). Now the shared connection has `commandTimeout: 500`
  and the throttler skips Valkey while it is `reconnecting`/`closed` and warns once per outage. The integration test
  checks five consecutive requests (< 1 s each).
- **Valkey roles**: the shared connection fails fast (`maxRetriesPerRequest: 1`, `commandTimeout`) so HTTP never hangs; BullMQ gets
  connection *options* (it owns and closes its connections) — blocking for workers, fail-fast for HTTP producers.
- **@bf/queue is framework-free**: `TypedProducer` (validation, trace context, job id from idempotency key) and
  `createJobRunner` (Template Method: validate → SET NX idempotency → consumer span → log context → handler →
  metrics). `TypedProcessor` in apps/api adapts it to `@nestjs/bullmq`'s `WorkerHost`. Cancellation: cross-process
  cancel key polled into an `AbortSignal`, combined with BullMQ 6's own worker signal; cancelled jobs never retry.
- **Bull Board** at `/admin/queues` (excluded from the `/v1` prefix) with basic auth, mounted only when
  `BULL_BOARD_USER`/`BULL_BOARD_PASSWORD` are set. TODO(BF-010): RBAC.
- **Coverage for apps**: unit gates measure `domain/`, `application/` and pure platform helpers (100 % lines); Nest
  wiring is proven by integration tests (25). New `@bf/testing` options: `plugins`, `coverageInclude`, `globalSetup`,
  and a Valkey Testcontainer (`@bf/testing/valkey`).
- **Lint**: Biome `useImportType` is off for apps/api — it would turn constructor-injected classes into type-only
  imports and break Nest DI at runtime (TypeScript's `verbatimModuleSyntax` still enforces real type imports);
  `noStaticOnlyClass` off for Nest dynamic modules; parameter decorators enabled in the parser.
- **Generator**: `pnpm gen:module <context>` (dependency-free templates in `tools/generators/module`);
  `pnpm gen:module:check` generates a module into the real app, typechecks, lints and runs its tests, then restores
  the tree (CI step in BF-009; not part of `verify` because it edits the working tree).
- Also in this ticket: `@bf/observability` → `@prometheus-io/client` (prom-client's new name) and a registered tracer
  provider even with `exporter: 'none'` (real trace ids in logs); `WORKER_METRICS_PORT` follows `BF_PORT_OFFSET`;
  generated OpenAPI/JSON Schema files excluded from Biome.
- Real run (offset 10, observability profile): `POST /v1/system/ping-jobs` → one Jaeger trace spanning `bf-api`
  (HTTP POST, Valkey eval/evalsha) and `bf-worker` (`job.process system`, idempotency `set`); both processes exit 0 on
  SIGTERM after logging graceful shutdown.
