# Observability

Every TypeScript process uses `@bf/observability` (ADR-0015): a redacting pino logger, OpenTelemetry tracing with
context propagated through jobs, Prometheus metrics, and shared health checks. Python (`services/intel`) follows
the same conventions with structlog and the OTel Python SDK (BF-008).

## See traces locally

```bash
pnpm infra:up --profile observability           # OTel collector (OTLP :4318) + Jaeger UI (:16686), plus offset
pnpm --filter @bf/observability demo:trace      # sends a request → enqueue → job trace, prints the Jaeger URL
```

`infra:up --profile observability` writes `OTEL_EXPORTER_OTLP_ENDPOINT` to `.env.generated`; apps export there
when it is set. Without the profile the variable is absent and nothing is exported. The collector also prints a
summary of what it receives: `pnpm infra:logs otel-collector`.

## Wiring a process

Telemetry must start **before** the modules it instruments are imported. With Node 24 ESM, use a preload:

```ts
// src/instrumentation.ts
import { register } from 'node:module';
import { initTelemetry } from '@bf/observability';

// ESM auto-instrumentation needs the import-in-the-middle loader hook.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
export const telemetry = initTelemetry({
  serviceName: 'bf-api',
  serviceVersion: process.env.APP_VERSION,
  exporter: env.OTEL_EXPORTER_OTLP_ENDPOINT ? 'otlp' : 'none',
  otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
});
```

```bash
node --import ./dist/instrumentation.js ./dist/main.js
```

Call `telemetry.shutdown()` from the app's shutdown hook (NestJS `onApplicationShutdown`), or pass
`shutdownOnSignals: true` for plain scripts. Tests use `exporter: 'none'` with an `InMemorySpanExporter` span
processor and `telemetry.forceFlush()` before asserting — no network.

Auto-instrumented: inbound/outbound HTTP, `fetch`/undici, ioredis (BullMQ/Valkey). **Not** instrumented:
postgres.js — OpenTelemetry has no instrumentation for it (`instrumentation-pg` covers the `pg` driver only), so
database work gets manual spans (`startSpan('db.<repository>.<operation>', …)`) where it matters.

## Jobs: one trace across the queue

```ts
// producer
await queue.add('enrich-business', { ...payload, ...injectTraceContext() });

// worker
await runWithExtractedContext(job.data, `job.process ${queue.name}`, () => useCase.execute(job.data));
```

The consumer span is a CONSUMER-kind child of the producer's context (same trace id) and links to the producer
span. `JobPayloadBase.traceparent` in `@bf/contracts` carries it.

## Logging

```ts
const logger = createLogger({ service: 'bf-api', level: env.LOG_LEVEL, env: env.NODE_ENV, version });
await withLogContext({ requestId, orgId, userId }, () => handler());
logger.info({ businessId }, 'business enriched');
```

Use pino's `(object, message)` signature; never interpolate data into the message.

### Field glossary

| Field | Meaning |
|---|---|
| `level`, `time`, `msg` | Severity (label), ISO-8601 UTC time, message |
| `service`, `env`, `version` | Process identity (`bf-api`, `bf-worker`, …), `NODE_ENV`, release |
| `traceId`, `spanId` | Active OpenTelemetry span — paste `traceId` into Jaeger |
| `requestId` | HTTP request id (also returned as a response header, BF-006) |
| `orgId`, `userId` | Authenticated workspace and user |
| `jobId`, `queue` | BullMQ job being processed |
| `err` | Serialized error: `type`, `message`, `stack` |

### Redaction (security.md §7)

- Exact paths: `req.headers.authorization`, `req.headers.cookie`, `req.headers["set-cookie"]`, `body.html`,
  `body.text`, plus `redactPaths`.
- Key names at **any depth**, including inside arrays (case- and `_`/`-`-insensitive): `password`, `passwd`,
  `secret`, `clientSecret`, `token`, `accessToken`, `refreshToken`, `idToken`, `apiKey`, `authorization`, `cookie`,
  `privateKey`, `credentials`, plus `redactKeys`.
- Email addresses are PII: log `hashEmail(email, pepper)` (`sha256:<16 hex>`), never the address.

## Naming

- **Spans**: `<module>.<operation>` in snake_case segments — `discovery.run`, `enrichment.fetch_website`,
  `sites.publish`. Jobs: `job.process <queue>`. Attributes use OTel semantic conventions where they exist,
  otherwise `bf.<name>` (`bf.org_id`, `bf.business_id`). Never put PII or secrets in attributes.
- **Metrics**: `bf_<area>_<name>_<unit>`, snake_case; counters end in `_total`; durations in seconds with
  `LATENCY_BUCKETS_SECONDS` — e.g. `bf_http_request_duration_seconds`, `bf_jobs_processed_total`,
  `bf_queue_depth_jobs`, `bf_llm_cost_usd_total`. `metrics.*` rejects other names. Keep label cardinality low
  (route templates, queue names, outcomes — never ids).
- Serve `metricsHandler()` at `/metrics` (default process and Node.js metrics included).

## Health

`/health/live` answers as long as the process runs; `/health/ready` runs `aggregateHealth(indicators)`:
every check in parallel with a timeout, `down` if a critical dependency fails, `degraded` if only non-critical
ones do. Errors are reported in the body, never thrown.
