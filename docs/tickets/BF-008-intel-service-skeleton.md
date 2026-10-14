---
id: BF-008
title: Python intel service skeleton (FastAPI, contracts codegen, SSRF-safe fetch)
milestone: M0 Foundations
epic: foundations
type: feature
priority: P0
size: M
depends_on: [BF-002, BF-004, BF-005]
blocks: [BF-019, BF-025, BF-026, BF-059]
areas: [intel]
---

# BF-008 — Python intel service skeleton (FastAPI, contracts codegen, SSRF-safe fetch)

## Context
`services/intel` is a stateless Python compute sidecar for crawling/extraction (Crawl4AI), open-data queries (DuckDB over Overture/Foursquare) and ML training ([ADR-0002](../adr/0002-typescript-first-with-python-sidecar.md)). It never touches the database; the TypeScript worker calls it over HTTP with a signed internal token. Its request/response models are generated from `@bf/contracts` JSON Schema (BF-004) so the two languages cannot drift.

## Goal
A production-ready FastAPI service skeleton with settings, structured logging, tracing, metrics, internal authentication, generated Pydantic contracts, an SSRF-safe HTTP fetch utility, a Playwright-capable Docker image, and checks wired into `pnpm verify`.

## Scope
**In scope**
- `services/intel` uv project (Python 3.13): `pyproject.toml`, `uv.lock`, `ruff` (lint+format), `mypy --strict`, `pytest` (+ `pytest-asyncio`, `respx`, `hypothesis`), `taskipy` tasks (`lint`, `format`, `typecheck`, `test`, `verify`).
- `package.json` shim so Turborepo runs Python checks in `pnpm verify` (`lint` → `uv run ruff check .`, `typecheck` → `uv run mypy app`, `test` → `uv run pytest -q`).
- App structure:
  ```
  app/
  ├── main.py                 # create_app(): routers, middleware, lifespan
  ├── settings.py             # pydantic-settings (INTEL_SHARED_SECRET, OTEL_*, S3_*, LOG_LEVEL, timeouts)
  ├── logging.py              # structlog JSON with trace ids, redaction
  ├── telemetry.py            # OTel SDK, FastAPI + httpx instrumentation
  ├── security/internal_auth.py  # HMAC bearer verification
  ├── net/safe_fetch.py       # SSRF-guarded async HTTP client
  ├── contracts/              # GENERATED Pydantic v2 models (do not edit)
  ├── routers/{health.py, echo.py}
  └── errors.py               # problem+json responses matching @bf/contracts
  tests/
  ```
- Internal auth: `Authorization: Bearer <unix_ts>.<nonce>.<hex_hmac_sha256(secret, ts|nonce|method|path|sha256(body))>`; max clock skew 60 s; nonce replay cache (in-memory TTL set) ; constant-time compare; 401 problem on failure. Provide the matching **TypeScript signer** as a tiny function in `@bf/contracts` (`signInternalRequest`) with cross-language test vectors (same inputs → same signature in both languages).
- `safe_fetch`: `httpx.AsyncClient` wrapper enforcing scheme/port allowlist, DNS resolution with private/reserved/link-local/CGNAT/metadata/IPv6-ULA/IPv4-mapped blocking, connect-to-resolved-IP (pin) with correct SNI/Host, redirect re-validation (max 5), total timeout, max body size, content-type allowlist option. Same rules documented for later Playwright request interception (BF-026).
- Contracts codegen: `pnpm contracts:py` → runs `pnpm contracts:jsonschema` (BF-004) then `uv run datamodel-codegen` for each schema into `app/contracts/`, with a header comment and stable output; CI-checkable via `git diff --exit-code`.
- Endpoints: `GET /health/live`, `GET /health/ready`, `GET /metrics` (prometheus-client), `POST /v1/echo` (auth required; uses a generated model `EchoRequest/EchoResponse` defined in `@bf/contracts` for this purpose) to prove the codegen path.
- Problem+json error handler mirroring `ProblemDetailsSchema` (codes from the shared registry exported to JSON).
- Dockerfile (`infra/docker/intel/Dockerfile`): multi-stage; base image with Playwright Chromium dependencies (verify the current official Playwright Python image tag) or `python:3.13-slim` + `playwright install --with-deps chromium`; non-root user; `uv sync --frozen --no-dev`; healthcheck; `uvicorn app.main:app` with workers configurable.
- Compose service `intel` added to `infra/compose/docker-compose.yml` under profile `apps` (optional for local dev; developers can run `uv run task dev`).

**Out of scope**
- Site intel, open-data and ML endpoints (→ BF-026, BF-019, BF-059). The TypeScript `IntelClient` adapter (→ BF-026).

## Requirements
### Functional
- Requests without a valid signature are rejected with 401 problem+json; valid ones pass.
- `safe_fetch` blocks `http://127.0.0.1`, `http://169.254.169.254`, `http://[::1]`, `http://10.0.0.5`, hostnames resolving to private IPs, and redirects to them.
### Non-functional
- Cold start < 2 s (without browsers); image size reasonable (document final size).
- `mypy --strict` clean; ruff clean.

## Design
- Dependency injection via FastAPI `Depends` for settings, HTTP client, clock.
- Keep CPU-bound work off the event loop (helper `run_cpu_bound(fn, *args)` using a process pool), used by later tickets.

## Implementation plan
1. uv project + tooling + package.json shim; verify `pnpm verify` runs Python checks.
2. Settings, logging, telemetry, metrics, health.
3. Internal auth with cross-language test vectors (+ TS signer in `@bf/contracts`).
4. `safe_fetch` with exhaustive tests (property-based for IP classification).
5. Contracts codegen + echo endpoint.
6. Dockerfile + compose service; README.

## Testing
- Unit: HMAC verification (valid, expired, replayed nonce, tampered body, wrong secret); IP classifier (hypothesis over IPv4/IPv6 ranges); redirect handling with `respx`; body-size limit; problem responses.
- Contract: generated models import and validate a sample payload; TS↔Python signature vectors identical.
- Container: `docker build` succeeds; container healthcheck passes (documented in PR).

## Acceptance criteria
- [x] `pnpm verify` runs ruff, mypy and pytest for `services/intel` and passes.
- [x] Signed requests from the TS signer are accepted by the service (cross-language test vectors).
- [x] `safe_fetch` blocks all listed SSRF cases (tests).
- [x] `pnpm contracts:py` regenerates models deterministically.
- [x] Docker image builds, runs as non-root and passes its healthcheck.

## Agent prompt
```text
Implement BF-008 (Python intel service skeleton).

Read first: AGENTS.md, docs/adr/0002-typescript-first-with-python-sidecar.md, docs/ARCHITECTURE.md §3,
docs/conventions/coding-standards.md §4, docs/conventions/security.md §4. Reuse @bf/contracts JSON Schema export
(BF-004) and the compose setup (BF-002).

Rules:
- Verify current versions/APIs: FastAPI, pydantic v2, pydantic-settings, structlog, OpenTelemetry Python,
  datamodel-code-generator, the official Playwright Python Docker image tag.
- Generated contracts are never hand-edited. Add the TS signer to @bf/contracts with shared test vectors.
- SSRF protection is security-critical: write the tests first, include IPv6 and redirect cases.

Verify: pnpm verify; cd services/intel && uv run task verify; docker build -f infra/docker/intel/Dockerfile .;
run the container and curl /health/ready; show a signed request succeeding and an unsigned one failing.
```

## References
- ADR-0002 · docs/conventions/security.md §4 · docs/conventions/coding-standards.md §4
- FastAPI: https://fastapi.tiangolo.com/ · uv: https://docs.astral.sh/uv/ · datamodel-code-generator: https://koxudaxi.github.io/datamodel-code-generator/ · OWASP SSRF prevention: https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

## Implementation notes
- **Versions**: Python 3.13.12 (uv 0.10), FastAPI 0.143.1 (Starlette 1.8), pydantic 2.14 / pydantic-settings 2.16,
  structlog 26.1, OpenTelemetry 1.45.1 / instrumentation 0.66b1, prometheus-client 0.26, httpx 0.28.1,
  uvicorn 0.54, datamodel-code-generator 0.83, Playwright 1.64 (Chromium 156), ruff 0.17, mypy 2.4, pytest 9.1.
  Starlette's TestClient now wants `httpx2` (dev dependency only); `safe_fetch` stays on httpx as the ticket says.
- **Auth before routing**: a pure-ASGI `InternalAuthMiddleware` caps the body (`INTEL_MAX_REQUEST_BYTES`) and
  verifies the signature before FastAPI parses anything (a router dependency would run *after* JSON decoding,
  leaking 422s with schema paths to unsigned callers — found in review). `require_internal_auth` stays on `/v1`
  routers as a fail-closed guard. Signed string: `ts|nonce|METHOD|raw path?query|hex(sha256(body))`.
- **Cross-language vectors**: `packages/contracts/fixtures/internal-auth-vectors.json` (5 cases incl. UTF-8 body,
  percent-encoded query, lower-case method); Vitest and pytest both assert them, and Python's stdlib was used to
  check them independently. Live check: TS-signed request → 200, replay → 401, unsigned → 401 problem+json.
- **safe_fetch**: validation per hop (scheme, port, no userinfo, LDH hostname after IDNA), resolve once, every
  record must pass `ip_policy`, connect to the IP with `Host` + `sni_hostname` (httpcore verifies the cert against
  it), manual redirects (max 5; cross-origin drops caller headers and refuses to resend a body), one `asyncio`
  deadline, body cap counted on raw and inflated bytes (only gzip/deflate requested, inflated with `max_length`),
  no env proxies, no keep-alive across hostnames, query strings kept out of logs/spans. Hypothesis covers the
  address classes; libc-resolved forms (`2130706433`, `0x7f000001`, `127.1`, `0177.0.0.1`) are tested too.
- **Contracts codegen**: one module per schema (snake_case), offline `$ref`s, fixed header, ruff-formatted; Zod's
  regex next to `format` is dropped (Pydantic rejects `pattern` on datetimes) — Python therefore accepts any UTC
  offset where Zod demands `Z` (DECISION in `scripts/gen_contracts.py`). `pnpm contracts:jsonschema` now also writes
  `generated/error-codes.json` (`typeBase` + codes), generated into `app/contracts/error_codes.py`.
  `pnpm contracts:check` fails on drift; a pytest test runs the same check.
- **Observability parity**: same log fields/order/redaction as pino (`[redacted]`, any depth), `traceId`/`spanId`,
  `requestId` from `x-request-id`; `bf_http_requests_total` / `bf_http_request_duration_seconds` with the shared
  buckets (unknown methods → `OTHER`); handled 5xx errors are logged and recorded on the span; probes untraced.
- **Config**: all variables declared in `@bf/config` (`apps/intel.ts`; added `NODE_ENV`, `APP_VERSION`, `INTEL_HOST`,
  `INTEL_WORKERS`, `INTEL_CPU_WORKERS`, `INTEL_MAX_REQUEST_BYTES`, `INTEL_FETCH_*`); a pytest test fails if
  `app/settings.py` and `.env.example` disagree. Empty values count as unset, as in `@bf/config`.
- **Image**: `python:3.13-slim` (trixie) + uv + `playwright install --with-deps --only-shell chromium`, both base
  images pinned by digest, uid 10001, healthcheck on `/health/ready`. **956 MB** (321 MB with
  `INSTALL_BROWSERS=false`). Cold start to first `/health/live`: **0.64 s** in the container. Compose profile
  `apps` runs it read-only with `cap_drop: [ALL]` and `no-new-privileges` (Chromium and the forkserver pool work).
- **Tests**: 154 pytest tests, 97 % coverage (gate 85 %); +8 Vitest tests for the signer.

