---
id: BF-005
title: Observability baseline (logging, tracing, metrics, health)
milestone: M0 Foundations
epic: foundations
type: infra
priority: P0
size: S
depends_on: [BF-001]
blocks: [BF-006, BF-008, BF-013, BF-061]
areas: [observability]
---

# BF-005 — Observability baseline (logging, tracing, metrics, health)

## Context
Work flows across HTTP, queues, a Python service, sandboxes and LLM providers. Without correlated logs and traces from day one, diagnosing failures later is guesswork. Decisions: [ADR-0015](../adr/0015-observability-otel-langfuse.md); conventions: [security.md §7](../conventions/security.md#7-logging--privacy).

## Goal
`@bf/observability` gives every TypeScript process a structured, redacting logger, OpenTelemetry tracing with context propagation across queues, Prometheus metrics helpers and shared health-check contracts — all configurable by env and silent in tests.

## Scope
**In scope**
- `packages/observability` (`@bf/observability`):
  - `createLogger({ service, level, pretty })` (pino): base fields `service`, `env`, `version`; mixin adding `traceId`/`spanId` from the active OTel context and `requestId`/`orgId`/`userId`/`jobId` from an `AsyncLocalStorage` log context; redaction paths (`req.headers.authorization`, `req.headers.cookie`, `*.password`, `*.secret`, `*.token`, `*.apiKey`, `*.refreshToken`, `body.html`, `body.text`, plus a `redactPaths` extension point); helper `hashEmail(email)` for logs.
  - `withLogContext(fields, fn)` and `getLogContext()`.
  - `initTelemetry({ serviceName, serviceVersion, exporter: 'otlp' | 'console' | 'none', samplingRatio })` using the OpenTelemetry Node SDK with auto-instrumentations for http, undici/fetch, pg/postgres.js (verify which instrumentation supports postgres.js), ioredis/valkey; graceful shutdown hook.
  - Context propagation for jobs: `injectTraceContext(): { traceparent, tracestate? }` and `runWithExtractedContext(carrier, name, fn)` creating a consumer span linked to the producer.
  - `startSpan(name, attrs, fn)` convenience with error recording.
  - Metrics: `metrics.counter/histogram/gauge` wrappers over prom-client with a shared registry, default process metrics, standard latency buckets; `metricsHandler()` returning Prometheus text.
  - Health contracts: `HealthIndicator` type and `aggregateHealth()` (used by Nest terminus adapter in BF-006 and by Next apps).
- `infra/compose/otel-collector.yaml` (used by the `observability` compose profile from BF-002): OTLP receiver → Jaeger exporter + debug logging.
- Docs: `docs/OBSERVABILITY.md` — how to see traces locally, log field glossary, naming conventions for spans (`<module>.<operation>`) and metrics (`bf_<area>_<name>_<unit>`).

**Out of scope**
- Python observability (→ BF-008). Langfuse/LLM spans (→ BF-013). Production collectors, dashboards, alerting (→ BF-061). Sentry wiring per app (each app ticket adds the DSN-based init; this package only exposes an optional helper).

## Requirements
### Functional
- A log line emitted inside a traced HTTP request contains the trace id; a job processed in a worker after `injectTraceContext` continues the same trace.
- Redaction removes listed fields even when nested in arrays/objects.
### Non-functional
- Logging overhead negligible (pino async destination in prod); `exporter: 'none'` in tests produces zero network calls.

## Design
```
packages/observability/src/
├── logger.ts        # createLogger, redaction, mixins
├── log-context.ts   # AsyncLocalStorage helpers
├── telemetry.ts     # initTelemetry, startSpan
├── propagation.ts   # injectTraceContext, runWithExtractedContext
├── metrics.ts       # prom-client wrappers, registry, handler
├── health.ts        # HealthIndicator, aggregateHealth
└── index.ts
```
- Telemetry must be initialized before other imports in app entrypoints (document the `--import` / preload pattern for Node 24 ESM).

## Implementation plan
1. Verify current OpenTelemetry JS SDK packages and instrumentation for postgres.js and ioredis/valkey.
2. Implement logger + redaction with tests.
3. Implement telemetry init, span helper and job propagation with an in-memory span exporter for tests.
4. Implement metrics + health helpers.
5. Collector config; docs.

## Testing
- Logger: snapshot of a log line with nested secrets → secrets absent; `hashEmail` stable; context fields included.
- Propagation: in-memory exporter; producer span → inject → extract in "consumer" → child span shares trace id.
- Metrics: counter increments appear in `metricsHandler()` output with correct names.

## Acceptance criteria
- [x] Logger redacts all configured paths (tests prove it), adds trace/log-context fields.
- [x] Trace context survives a simulated queue hop (tests prove it).
- [x] Metrics endpoint helper outputs Prometheus text with default process metrics.
- [x] `observability` compose profile shows a demo trace in Jaeger (script `pnpm --filter @bf/observability demo:trace` documented in PR).
- [x] `docs/OBSERVABILITY.md` written.

## Agent prompt
```text
Implement BF-005 (Observability baseline) in packages/observability.

Read first: AGENTS.md, docs/adr/0015-observability-otel-langfuse.md, docs/ARCHITECTURE.md §14,
docs/conventions/security.md §7.

Rules:
- Verify current OpenTelemetry JS package names/APIs and which instrumentations support postgres.js and ioredis
  (the Valkey client) before coding; record versions in the PR.
- Tests must not open network connections: use in-memory exporters.
- Redaction is a security feature: write the tests first, including nested/array cases.

Verify: pnpm verify; with `pnpm infra:up --profile observability`, run the demo trace script and attach a
screenshot or the Jaeger trace JSON to the PR.
```

## References
- ADR-0015 · docs/ARCHITECTURE.md §14 · docs/conventions/security.md §7
- OpenTelemetry JS: https://opentelemetry.io/docs/languages/js/ · pino redaction: https://getpino.io/#/docs/redaction · prom-client: https://github.com/siimon/prom-client

## Implementation notes
- **Versions**: pino 10.4.0, prom-client 15.1.3, @opentelemetry/api 1.9.1, sdk-node / exporter-trace-otlp-http /
  instrumentation-http 0.223.0, sdk-trace-base / resources / core 2.12.0, instrumentation-undici 0.33.0,
  instrumentation-ioredis 0.71.0, semantic-conventions 1.43.0.
- **postgres.js has no OpenTelemetry instrumentation** (`instrumentation-pg` is for `pg`); DB spans are manual.
  Valkey/BullMQ go through ioredis, which is instrumented. Only http, undici and ioredis instrumentations are
  installed instead of the ~40-package auto-instrumentations bundle.
- **Deep redaction**: pino `redact` paths cannot express "any depth", so sensitive key names are also removed
  recursively in the log formatter (arrays, cycles, depth limit). Errors keep `type`/`message`/`stack` (a
  test-first case caught that the formatter otherwise erased them).
- **`exporter: 'none'` makes zero network calls**: span/log/metric processor lists are passed explicitly so
  the SDK never falls back to `OTEL_*` env exporters.
- **`forceFlush()`** on the telemetry handle: SDK 2.x processors export asynchronously after resource detection,
  so tests and short-lived scripts must flush.
- Queue hop: consumer span is a CONSUMER child of the extracted context (same trace) plus a link to the producer;
  Jaeger shows it as `FOLLOWS_FROM demo.enqueue` in the same trace.
- Sentry helper not added (not in the in-scope list); each app ticket wires its own DSN init.
- Collector config was delivered with BF-002 (`infra/compose/otel-collector.yaml`).
