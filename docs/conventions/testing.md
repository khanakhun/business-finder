# Testing strategy

## 1. Pyramid and ownership

| Level | Scope | Tools | Runs |
|---|---|---|---|
| Unit | Domain logic, pure functions, mappers, prompt rendering, React components in isolation | Vitest (+ Testing Library), pytest | every PR |
| Integration | Repositories, queries, processors, adapters against real Postgres/Valkey; HTTP controllers with the Nest testing module | Vitest + Testcontainers + Supertest, pytest + docker services | every PR (`pnpm test:int`) |
| Contract | OpenAPI snapshot, Zod ⇄ Pydantic JSON Schema compatibility, engine event parsers vs recorded CLI streams | Vitest, pytest | every PR |
| E2E | Critical user journeys on the full stack | Playwright against compose stack with seeded data and the fake LLM provider | every PR touching `apps/web` / API flows; nightly full |
| Visual | Site blocks × styles × breakpoints; key dashboard screens | Playwright screenshots | PRs touching `@bf/site-blocks` / `@bf/ui` |
| Performance | Hybrid search p95, discovery ingest throughput | Vitest bench / autocannon on seeded dataset | nightly + on demand |
| Evals | LLM task quality on curated datasets | `pnpm eval` (real models) | nightly + prompt/model changes |

Critical journeys covered by E2E: sign-up → workspace; NL search → results; discovery run progress; business detail → status change; batch generation → preview opens; one-click send (to Mailpit) → appears in timeline; reply in Mailpit/fake mailbox → triaged; unsubscribe link → suppression.

## 2. Conventions

- File placement: `src/**/x.test.ts` next to code; integration `*.int.test.ts`; E2E in `apps/web/e2e/`.
- Naming: `describe('<unit>')` + `it('<behaviour> when <condition>')`. One behaviour per test.
- Arrange/Act/Assert sections separated by blank lines; no logic (loops/ifs) in assertions.
- Use builders/factories from `@bf/testing` (`aBusiness().withWebsite().inGustavia().build()`), seeded `@faker-js/faker` for determinism. Fixtures contain **fake** data only.
- Time: `FixedClock` / Vitest fake timers. No `sleep`; use `waitFor` helpers with explicit timeouts.
- Randomness: inject RNG; seed it in tests.

## 3. Database tests

- `@bf/testing/db` starts one Postgres container (custom image with PostGIS + pgvector) per test run (Vitest `globalSetup`), runs migrations once, and gives each test file its own schema-cloned database **or** wraps each test in a transaction that is rolled back. Choose rollback for repository tests; database-per-file for tests that need multiple connections (outbox relay, SKIP LOCKED schedulers).
- Never mock Drizzle. If a query is hard to test, the query is too complex — split it.
- Performance-sensitive queries get an `EXPLAIN` assertion test (index used, no seq scan on large tables) against a seeded dataset.

## 4. Queues and workers

- Integration tests run real BullMQ against a Valkey container; processors are invoked through the real queue.
- Test idempotency explicitly: run the same job twice → one side effect.
- Test failure paths: retryable error retries with backoff; `UnrecoverableError` does not; cancellation stops work and leaves consistent state.
- Crash recovery: kill a worker mid-job (close the worker) → reconciler re-enqueues from DB state.

## 5. External services

- TypeScript: MSW handlers per provider in `@bf/testing/msw/<provider>.ts` with realistic recorded payloads (scrubbed).
- Python: `respx` for httpx; `pytest-recording` (VCR) for cassettes; local fixture websites served by a test HTTP server for crawler tests (no live internet in tests).
- Provider adapters must have contract tests that parse recorded payloads into normalized `SourceRecord`s.

## 6. LLM-dependent code

- Unit/integration tests use `createFakeAiProvider()` from `@bf/ai/testing`: responses are recorded fixtures keyed by `(task, promptVersion, inputHash)`. Missing fixture → test fails with instructions to record (`AI_FIXTURES=record pnpm test ...` with real keys, reviewed before commit).
- Test the **contract**, not the prose: schema validity, required fields, grounding (facts used ⊆ fact registry), refusal paths, repair paths.
- Evals live in `packages/ai/evals/<task>/` as JSONL (`input`, `expected`, `tags`), with scorers (exact match, set F1, LLM-as-judge with rubric). Each task declares a threshold; `pnpm eval` fails below it and writes a report.

## 7. Frontend

- Components: Testing Library, user-centric queries (`getByRole`), no snapshot tests of large trees.
- Accessibility: `@axe-core/playwright` on key pages in E2E; zero serious/critical violations.
- E2E data setup via API helpers (not UI clicks) and teardown by workspace deletion.

## 8. Coverage and gates

- Coverage via V8: packages ≥ 80% lines; `domain/` folders ≥ 90% branches. Python ≥ 85% lines.
- CI fails on: lint, type errors, failing tests, coverage below thresholds for touched packages, stale generated code (OpenAPI client, Pydantic models), `drizzle-kit check` drift.

## 9. Flaky tests

A flaky test is a bug. Quarantine it within a day (`it.skip` with `TODO(BF-xxx)` and an issue), fix within a week. Never add retries to hide flakiness.
