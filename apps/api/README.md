# @bf/api

NestJS 12 modular monolith (ADR-0005) with two process types sharing one codebase:

| Process | Entrypoint | What it runs |
|---|---|---|
| HTTP API | `src/main.ts` | REST under `/v1`, `/health/*`, `/metrics`, `/docs` (non-production), `/admin/queues` |
| Worker | `src/worker.ts` | BullMQ processors; `/metrics` and `/health/live` on `WORKER_METRICS_PORT` |
| OpenAPI | `src/openapi.ts` | Builds `packages/api-client/openapi.json` with no env and no infrastructure |

```bash
pnpm infra:up                         # Postgres, Valkey, … (see the root README)
pnpm db:migrate
pnpm --filter @bf/api dev             # HTTP (API_PORT, 4000 + offset) and worker together, watch mode
pnpm --filter @bf/api dev:api         # or just one of them: dev:api / dev:worker
pnpm api:openapi                      # regenerate the OpenAPI document (a test fails if it is stale)
pnpm gen:module <context>             # scaffold a new module (see below)
```

Code runs through the SWC loader (`@swc-node/register`): NestJS needs decorator metadata, which Node's type
stripping and esbuild do not emit. `src/instrumentation.ts` is preloaded so OpenTelemetry patches modules before
they load.

## Layout

```
src/
├── main.ts · worker.ts · openapi.ts · instrumentation.ts · http.ts
├── app.module.ts                 # AppModule.forHttp() / forWorker() / forOpenApi()
└── modules/
    ├── platform/                 # shared kernel (below)
    └── system/                   # reference module: copy its shape
        ├── domain/               # pure TypeScript: entities, value objects, rules
        ├── application/          # use cases (*.command.ts / *.query.ts), ports (interfaces + DI tokens)
        ├── infrastructure/       # adapters implementing ports (Drizzle, BullMQ, HTTP clients)
        ├── interface/            # controllers, processors: parse → (authorise) → delegate
        └── system.module.ts      # wiring per mode
test/create-test-app.ts           # boots the real app on an isolated DB + test Valkey
```

Dependency direction: `interface → application → domain`; `infrastructure` implements `application` ports.
Domain code imports no framework. Each mode wires only what it needs — controllers for HTTP, processors for the
worker, and no queue connections in OpenAPI mode.

### Platform (shared kernel)

| Concern | Where | Notes |
|---|---|---|
| Config | `config/` | `loadAppEnv(mode)` validates `@bf/config` (`apiEnv` / `workerEnv`); token `APP_ENV` |
| Database | `db/` | `DB_CLIENT` (lazy postgres.js pool), `@Transactional()` over `runInTransaction` |
| Valkey | `valkey/` | `VALKEY` shared connection, fails fast; BullMQ opens its own (blocking for workers) |
| Clock | `clock/` | `CLOCK` token; tests override it with `fixedClock()` |
| Request context | `context/` | `x-request-id` (echoed or generated), ALS context + log context |
| Validation | `validation/` | `zodDto(schema)` parameter classes + global `ZodValidationPipe`; `@ApiRoute` |
| Errors | `errors/` | Global filter → RFC 9457 `application/problem+json`; 5xx never leak internals |
| Resilience | `resilience/` | `@WithResilience('policy')`: timeout, retry with jitter, circuit breaker (cockatiel) |
| Security | `security/` | helmet, CORS (APP_URL), throttling 300/min/user · 60/min/IP on Valkey (fails open) |
| Health/metrics | `health/`, `metrics/` | `/health/live`, `/health/ready` (DB + Valkey), Prometheus `/metrics` |
| Queues | `queue/` | BullMQ registration, `TypedProcessor`, Bull Board (signed-in, `settings:manage`) |
| Security | `security/` | `AuthContext`, `@AllowAnonymous`/`@RequirePermission`/`@NoOrgRequired`/`@Ctx`, `AuthorizationGuard`, throttling |
| OpenAPI | `openapi/` | OpenAPI 3.1 from Nest routes + Zod schemas (`.meta({ id })` → components) |

## Authentication and authorization (BF-010)

- **Better Auth** (`@bf/auth`) is mounted at `/api/auth/*` by `http.ts`, before Nest's body parsers. Only the
  endpoints in `identity/infrastructure/better-auth-http.ts` are reachable; membership changes and API keys go
  through `/v1` so the domain rules (last owner, who may grant which role, no permission escalation) hold.
- Every request's credentials are resolved once (`BetterAuthResolver`, an Express middleware in `http.ts`): the
  session cookie, or `Authorization: Bearer bf_…` (an organization API key). Org context comes only from the
  session's active workspace or the key's workspace.
- Every route declares exactly one policy — `@RequirePermission(...)` (the default choice), `@NoOrgRequired()`
  (caller acting on themselves) or `@AllowAnonymous()`. A route without one is refused, and `src/routes.test.ts`
  fails. 401 = no/invalid credentials; 403 = no workspace, missing permission, or a cross-origin session write;
  resources of another workspace are 404.
- First owner: `pnpm admin:bootstrap --email … --name … --workspace …` (prints a one-time set-password link).
- Sign-up policy: `SIGNUP_MODE` (`invite_only` by default in production, `open` otherwise).

### Anonymous routes

Reviewed list (kept in sync with `src/routes.test.ts`):

| Route | Why |
|---|---|
| `GET /health/live`, `GET /health/ready` | Probes |
| `GET /metrics` | Prometheus scrape (internal network) |
| `GET /v1/system/info` | Version and environment for the dashboard's connection card and deploy checks |
| `GET /v1/identity/config` | Which sign-in/sign-up options the auth pages may show (sign-up mode, Google) |
| `POST /v1/public/sites/views` | View beacon of published sites (BF-035): a token signed by the renderer, 120/min per IP; stores no IP or user agent |
| `GET /v1/public/sites/altcha-challenge`, `POST /v1/public/sites/leads` | Lead forms of previews (BF-048): signed site and form tokens, self-hosted proof of work, honeypot, rate limits on a daily network hash, CORS to the sites domain only; always "received"; stores no IP |
| `GET /v1/internal/domains/allow` | Caddy's on-demand TLS `ask` (BF-062): a shared token in the ask URL (Caddy sends no header), 200 only for verified or active custom domains, 403 otherwise; the edge proxy does not route `/v1/internal/*` publicly |
| `POST /v1/public/sites/contact-routing/confirm` | The live site contact address confirmation (BF-062): a single-use, 7-day token emailed to that address (only its SHA-256 stored); the same answer for unknown or expired tokens; 10/min |
| `GET /v1/mailboxes/oauth/:provider/callback` | Google/Microsoft redirect after mailbox consent (BF-050): an HMAC-signed state pointing to a single-use, 10-minute attempt stored server-side (org, user, PKCE verifier); answers only with a redirect to Settings → Mailboxes |
| `POST /v1/public/unsubscribe/:token`, `GET`/`POST /u/:token` | Unsubscribe (BF-055): RFC 8058 one-click (any POST to the `List-Unsubscribe` URL) and the human page (GET never acts; POST applies the choices); 128-bit tokens looked up by SHA-256; unknown or expired tokens get the same generic answer; rate-limited; no cookie |
| `POST /v1/public/sites/dsr` | Data-subject requests from a preview's privacy page (BF-055): signed site token, 5/min, the lead forms' network-hash rate limits; recorded as `received` for a person to verify (nothing is exported or erased from here); always "received" |
| `/api/auth/*` (allowlisted) | Sign-up, sign-in, verification, password reset, 2FA — Better Auth enforces its own rules |

## Workspace settings, secrets and audit log (BF-011)

- `modules/workspace`: settings (`org_settings`), the secrets vault (`secrets`, envelope-encrypted with
  `platform/crypto/envelope.ts`), feature flags and the append-only audit log (`audit_logs`, enforced by a trigger).
  Other modules use only `workspace/index.ts`: `AuditLogger.record()`, `SecretResolver.resolve()` (workspace value,
  then the deployment env fallback), `ConnectionTesterRegistry.register()`, `FeatureFlagService.isEnabled()`,
  `WorkspaceReadiness.forOutreach()`.
- Secret values are write-only through the API (metadata and `last4` only) and never logged or audited
  (integration tests search responses, audit rows and logs for a sentinel value).
- Identity events (invitations, role changes, removals, API keys) are recorded in the audit log.
- Master key rotation: `pnpm secrets:rotate-master` — see [docs/runbooks/secrets-rotation.md](../../docs/runbooks/secrets-rotation.md).
- `FAKE_CONNECTION_TESTS=true` (development/E2E only, refused in production) registers testers that pass without
  calling providers.

## Domain events and the outbox (BF-012)

- Define events in `@bf/contracts` (`defineEvent('<context>.<entity>_<past_tense>', version, payloadSchema)`), record
  them inside the use case's transaction with `EventRecorder.record(Definition, { payload })` (org, actor,
  correlation and causation come from the request or the event being handled).
- Subscribe with `@OnDomainEvent([Definition], { id: '<context>.<name>' })` on an injectable's method. The id is
  stable: it keys idempotency (`<eventId>:<id>`). Handlers must be idempotent (e.g. insert with the event id).
- The worker's `OutboxRelay` (LISTEN `bf_outbox` + 2 s polling, `FOR UPDATE SKIP LOCKED`) enqueues one `events`
  job per event × subscriber; `EventDeliveryProcessor` runs it with retries; `OutboxReconciler` re-dispatches
  stuck events. Metrics: `bf_outbox_dispatch_lag_seconds`, `bf_outbox_events_dispatched_total`,
  `bf_outbox_pending_events`, `bf_events_handled_total`.
- Owners can re-deliver an event to a subscriber: `POST /v1/events/{eventId}/replay`.

## AI (BF-013)

- Inject the gateway: `@Inject(AI_GATEWAY) private readonly ai: AiGateway` (`platform/ai/ai.module.ts`) and call
  `ai.run(Task, input, { orgId })` / `stream` / `embed` / `vision`. Tasks, prompts and evals live in `@bf/ai`
  (see `packages/ai/README.md`); feature modules never import provider SDKs.
- Keys: the workspace vault (`anthropic`, `openai` secrets), else `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.
  Missing → `AiProviderNotConfiguredError` (409, `reason: AI_PROVIDER_NOT_CONFIGURED`, `secretName`).
- Every call writes an `llm_calls` row (tokens, cost from `AI_PRICING`, latency, status); responses are cached in
  Valkey per task/prompt version/model/input. Monthly budgets per workspace: `AI_BUDGET_MONTHLY_SOFT_USD`
  (records `ai.budget_soft_limit_reached` once a month) and `_HARD_USD` (non-essential tasks get 402).
- `GET /v1/ai/usage` (`settings:manage`): totals by task, model and day, plus the month-to-date spend.
- Tracing: AI SDK spans via `@ai-sdk/otel`; Langfuse when `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` are set (only
  LLM spans; bodies only with `AI_TRACE_CONTENT=true`, emails/phones masked).

## Adding things

**A module.** `pnpm gen:module lead-capture` writes contracts, all four layers, a Drizzle repository stub, a
controller, module wiring and tests, and registers it in `AppModule` and the contracts index. Then: add the
table in `packages/db` (`pnpm db:generate`), implement the repository with `getExecutor(this.db)` plus an
integration test, and run `pnpm api:openapi`. `pnpm gen:module:check` proves the templates still compile.

**An endpoint.** Define the request/response schemas in `@bf/contracts` (with `.meta({ id })`), add a use case,
then in the controller:

```ts
class CreateThingBody extends zodDto(CreateThingRequestSchema) {}

@Post()
@ApiRoute({ summary: 'Create a thing', body: CreateThingBody, response: { status: 201, schema: ThingSchema }, errors: [409] })
create(@Body() body: CreateThingBody) {
  return this.createThing.execute(body);
}
```

Validation (422), the OpenAPI entry and the response contract check (dev/test) all come from those declarations.
Throw `DomainError` subclasses from use cases; never build HTTP responses by hand.

**A job.** Declare it in `@bf/contracts` (`defineJob('queue', 'name', shape)`), add the queue to `QUEUES` in
`@bf/queue`, produce through a port whose adapter wraps `TypedProducer`, and process with:

```ts
@Processor(QUEUES.enrichment.name, { concurrency: QUEUES.enrichment.concurrency })
export class EnrichProcessor extends TypedProcessor<typeof EnrichBusinessJob, void> {
  protected readonly definition = EnrichBusinessJob;
  async handle(payload, context) {
    await this.enrichBusiness.execute(payload, context.signal); // pass the AbortSignal through
  }
}
```

`TypedProcessor` validates the payload (invalid → failed, no retry), enforces idempotency on
`idempotencyKey`, continues the producer's trace, sets log context, aborts `context.signal` on cancellation
(`requestCancellation()` from `@bf/queue`) and records `bf_jobs_processed_total` / `bf_job_duration_seconds`.

## Tests

- `pnpm --filter @bf/api test` — unit tests (SWC transform for decorators). Coverage is measured on the logic
  layers (`domain/`, `application/`, pure platform helpers); framework wiring is proven by integration tests.
- `pnpm --filter @bf/api test:int` — boots the real app per file with `createTestApp()` (isolated database cloned
  from the migrated template, test Valkey) and, for jobs, `createTestWorker()`.
