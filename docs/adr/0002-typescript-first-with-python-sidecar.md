# ADR-0002: TypeScript-first services with a Python sidecar for intel and ML

- Status: Accepted
- Date: 2026-10-14
- Tickets: BF-006, BF-008, BF-026, BF-019, BF-059

## Context

Most of the system is web application logic, orchestration and integrations (auth, CRUD, queues, email APIs, site rendering, coding-agent CLIs). A few capabilities are clearly stronger in Python: LLM-friendly crawling/extraction (Crawl4AI), large columnar open-data queries (DuckDB over Overture/Foursquare GeoParquet) and classical ML (scikit-learn for the outcome model). Running two languages means two toolchains, so the boundary must be small and simple.

## Decision

- **TypeScript is the default** for all apps and business logic (Next.js, NestJS, shared packages).
- **`services/intel` (Python, FastAPI)** is a **stateless compute sidecar** with bounded-time HTTP endpoints:
  - `POST /v1/site-intel` — crawl + extract + fingerprint + screenshots for one website;
  - `POST /v1/open-data/places/search` — Overture / Foursquare queries by bbox + categories;
  - `POST /v1/ml/train`, `GET /v1/ml/models/{id}` — outcome-model training jobs (async, artifact to object storage).
- Python **never writes to PostgreSQL**. The TypeScript worker calls intel within a BullMQ job (with timeout, retry, circuit breaker) and persists results through the owning module. This keeps one schema owner and one migration system.
- Contracts: Zod schemas in `@bf/contracts` are exported to JSON Schema and code-generated into Pydantic v2 models (`pnpm contracts:py`); a CI check fails if generated models are stale.
- Service-to-service auth: internal network only plus a shared HMAC-signed bearer token with short TTL (`INTEL_SHARED_SECRET`).
- Model inference for the outcome model (logistic regression) is executed in TypeScript from exported coefficients, so scoring stays in-process.

## Alternatives considered

| Option | Why not |
|---|---|
| All TypeScript | Crawl4AI/DuckDB/scikit-learn equivalents are weaker; we would rebuild mature tooling. |
| All Python (FastAPI backend + Next.js) | Loses NestJS structure, Better Auth, the AI SDK UI integration and the TypeScript-native agent tooling (Claude Agent SDK, sitekit, Puck). |
| Python workers consuming BullMQ directly | The BullMQ Python package is documented as experimental; cross-language job semantics (flows, retries, progress) would be a reliability risk. |
| Python writing directly to the DB | Two ORMs, two migration owners, duplicated invariants. |

## Consequences

- Positive: each language does what it is best at; the Python boundary is a handful of idempotent endpoints that are easy to test and mock.
- Positive: intel can scale independently (it is CPU/browser heavy).
- Negative: payloads cross HTTP (site intel bundles can be large) — screenshots and raw markdown go to object storage, only references and structured data are returned.
- Negative: two dependency ecosystems to keep updated.

## References

- BullMQ Python docs (status: experimental): https://docs.bullmq.io/python/introduction
- Crawl4AI: https://github.com/unclecode/crawl4ai
- DuckDB spatial: https://duckdb.org/docs/extensions/spatial/overview
