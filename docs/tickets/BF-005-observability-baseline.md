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
- [ ] Logger redacts all configured paths (tests prove it), adds trace/log-context fields.
- [ ] Trace context survives a simulated queue hop (tests prove it).
- [ ] Metrics endpoint helper outputs Prometheus text with default process metrics.
- [ ] `observability` compose profile shows a demo trace in Jaeger (script `pnpm --filter @bf/observability demo:trace` documented in PR).
- [ ] `docs/OBSERVABILITY.md` written.

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
