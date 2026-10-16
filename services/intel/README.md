# services/intel

Stateless Python compute sidecar ([ADR-0002](../../docs/adr/0002-typescript-first-with-python-sidecar.md)):
crawling/extraction (BF-026), open-data queries (BF-019) and ML training (BF-059) behind a few bounded-time HTTP
endpoints. It **never touches the database**: the TypeScript worker calls it with a signed request and persists
results itself.

Python 3.13 · FastAPI · pydantic v2 · structlog · OpenTelemetry · prometheus-client · httpx · uv.

```bash
pnpm --filter @bf/intel dev     # uvicorn with reload on INTEL_PORT (8000 + BF_PORT_OFFSET); reads ../../.env*
cd services/intel
uv run task verify              # ruff (lint + format), mypy --strict, pytest (coverage ≥ 85 %)
uv run task --list              # dev, lint, format, typecheck, test, verify, contracts
pnpm contracts:py               # (repo root) regenerate app/contracts from @bf/contracts
pnpm infra:up --profile apps    # (repo root) run the container image instead, next to the infrastructure
```

`pnpm verify` runs this service's checks through `package.json` (Turborepo cannot run Python directly). The Python
toolchain is uv: `uv run` creates `.venv` from `uv.lock` on first use.

## Layout

```
app/
├── main.py               create_app(): settings → logging → tracing → state → routers → middleware
├── serve.py              `python -m app.serve [--reload]` (uvicorn, INTEL_WORKERS)
├── settings.py           pydantic-settings; the only module that reads the environment
├── logging.py            structlog JSON, same fields and redaction as @bf/observability
├── telemetry.py          OTel tracer provider (OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set) + FastAPI spans
├── metrics.py            per-app Prometheus registry: bf_http_requests_total, bf_http_request_duration_seconds
├── middleware.py         request id (x-request-id), one access log line, metrics, unhandled error → 500 problem
├── errors.py             IntelError + problem+json handlers (codes from the shared registry)
├── health.py             aggregate_health(): same report shape as the API's /health/ready
├── concurrency.py        CpuPool.run_cpu_bound(fn, *args): CPU-bound work in a process pool
├── security/internal_auth.py   HMAC verification: InternalAuthMiddleware (/v1) + require_internal_auth guard
├── net/ip_policy.py      which addresses outbound requests may reach
├── net/safe_fetch.py     SSRF-guarded fetching for user/provider/crawled URLs
├── contracts/            GENERATED Pydantic models — never edit (pnpm contracts:py)
└── routers/              health.py (/health/live, /health/ready, /metrics) · echo.py (POST /v1/echo)
scripts/gen_contracts.py  JSON Schema → Pydantic (deterministic; --check for CI)
```

## Contracts

Request/response shapes are Zod schemas in `@bf/contracts`, opted in with `exportSchema(…, { exportTo:
['python'] })` in `packages/contracts/src/registry.ts`. `pnpm contracts:py` exports them to JSON Schema
(`packages/contracts/generated/`) and generates one module per schema into `app/contracts/` plus
`error_codes.py` (the error registry). `pnpm contracts:check` fails when either side is stale; a pytest test runs
the same check. Zod's regex next to a `format` is dropped during generation (Pydantic types the field instead), so
`date-time` fields accept any UTC offset where Zod insists on `Z`.

## Internal authentication

`InternalAuthMiddleware` (pure ASGI) authenticates every request under `/v1` **before routing**: it caps the
body (`INTEL_MAX_REQUEST_BYTES`, 413 otherwise), verifies the signature, then replays the body to the app. So an
unsigned caller gets a 401 and never reaches JSON parsing or validation (no 422 revealing a schema). Each `/v1`
router also declares the `require_internal_auth` dependency, which fails closed if a protected router is ever
mounted where the middleware does not run.

```
Authorization: Bearer <unix_ts>.<nonce>.<hex(hmac_sha256(INTEL_SHARED_SECRET, ts|nonce|METHOD|path?query|hex(sha256(body))))>
```

- The TypeScript caller signs with `signInternalRequest({ method, path: url.pathname + url.search, body }, { secret })`
  from `@bf/contracts`. Both implementations are pinned to `packages/contracts/fixtures/internal-auth-vectors.json`.
- Accepted clock skew ±60 s; nonces (16–64 base64url chars) are remembered for 120 s, so a captured request cannot
  be replayed. The cache is per process: with several workers a replay could reach another worker within the
  window — acceptable on the internal network; prefer replicas over workers anyway.
- Failures are a generic 401 `UNAUTHENTICATED` problem; the reason is logged, never returned.

## safe_fetch (SSRF)

Use `SafeFetcher` (one per process: `request.app.state.safe_fetcher`) for any URL that comes from a user, a
provider or a crawled page — never a plain HTTP client. Per hop (first request and every redirect, max 5):

1. scheme `http`/`https`, port in the allowlist (80/443 by default), no credentials in the URL, a syntactically
   valid hostname (IDNs are punycode-encoded first);
2. resolve once; **every** address must be public: not loopback, private, link-local (cloud metadata), CGNAT,
   multicast, reserved, unspecified, unique-local, Teredo — and IPv4-mapped / NAT64 / 6to4 addresses are judged by
   the IPv4 address they embed;
3. connect to that address (pinning, so DNS rebinding cannot swap it) with the hostname in `Host` and in TLS SNI,
   so the certificate is still verified against the hostname.

Also: one time budget for the whole call (`INTEL_FETCH_TIMEOUT_SECONDS`), a body cap after decompression
(`INTEL_FETCH_MAX_BYTES`; only gzip/deflate are requested, inflated with a bounded output), an optional
content-type allowlist, no environment proxies, no connection reuse across hostnames. On a redirect to another
origin, caller headers (credentials, cookies) are dropped and a request body is never resent. Logs and spans
record fetched URLs without their query string (tokens often live there). BF-026 applies the same
`ip_policy` rules to Playwright request interception.

## Container image

`infra/docker/intel/Dockerfile` (build context: repo root): `python:3.13-slim` (trixie) + uv, dependencies from
`uv.lock` without dev tools, Playwright's headless Chromium with its system libraries, runs as uid 10001,
`HEALTHCHECK` on `/health/ready`, `CMD python -m app.serve`. Base images are pinned by digest. The compose
service runs it with a read-only root filesystem (tmpfs `/tmp`), no capabilities and `no-new-privileges`;
Chromium and the process pool work under those limits.

| Variant | Size | Notes |
|---|---|---|
| default | 955 MB | Chromium headless shell + system libraries (needed from BF-026) |
| `--build-arg INSTALL_BROWSERS=false` | 321 MB | no browser |

Cold start to the first `/health/live` answer: ~0.65 s in the container (target < 2 s, browsers not launched).

## Operations notes

- **Workers.** Metrics, the nonce cache and the CPU pool are per process. Scale with replicas (`INTEL_WORKERS=1`,
  the default); several workers log a warning at start.
- **CPU pool.** `forkserver` start method (forking a process that already runs threads can deadlock); a pool
  broken by a crashed worker is recreated on the next call.
- **Readiness errors** are returned in the `/health/ready` body like the API's, so keep dependency error messages
  free of credentials (the port is internal-only).

## Configuration

Declared once in `@bf/config` (`packages/config/src/apps/intel.ts`, documented in `docs/ENVIRONMENT.md`);
`tests/test_settings.py` fails if `app/settings.py` and `.env.example` disagree. Locally the service reads the
repo's `.env` and `.env.generated` (written by `pnpm infra:up`); in a container only the environment.
