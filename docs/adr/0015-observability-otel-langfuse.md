# ADR-0015: Observability with OpenTelemetry, pino/structlog, Langfuse and Sentry

- Status: Accepted
- Date: 2026-10-14
- Tickets: BF-005, BF-013, BF-061

## Context

Work flows across HTTP requests, queues, a Python service, sandboxes and LLM providers. Diagnosing "why did this site generation fail" or "why did this email not send" requires correlated logs and traces, plus LLM-specific visibility (prompts, tokens, costs) and business metrics (queue depth, bounce rates).

## Decision

- **Logs**: structured JSON — pino in TypeScript, structlog in Python — with `traceId`, `spanId`, `requestId`, `orgId`, `userId`, `jobId`, `queue` fields; redaction list for secrets and PII (emails are hashed in logs except in the dedicated outreach audit trail).
- **Traces**: OpenTelemetry SDK in api, worker and intel with auto-instrumentation (HTTP, undici/fetch, pg, ioredis) plus manual spans for jobs (`job.process <queue>`) propagating context through job data (`traceparent`). OTLP export to a collector; backend is deployment-specific (Grafana Tempo, Jaeger, or a vendor).
- **LLM observability**: AI SDK telemetry spans exported to **Langfuse** (self-hosted or cloud) with prompt version, model, tokens, cost; local `llm_calls` ledger for budgets.
- **Metrics**: Prometheus format at `/metrics` on api/worker/intel (prom-client / prometheus-client): HTTP RED metrics, queue depth & oldest-job age, job outcomes, provider quota usage, mailbox sends/bounces, LLM spend.
- **Errors**: Sentry SDKs (optional via DSN) in web, api, worker, sites, intel with release tags.
- **Health**: `/health/live` and `/health/ready` (dependencies) on every service.

## Consequences

- Positive: one trace per user action across services and jobs; cost visibility for AI.
- Negative: some setup cost in BF-005; collectors/backends are optional locally (console exporter in dev).
