# AGENTS.md — instructions for AI coding agents

This file is the single source of truth for any coding agent (Claude Code, Codex, Cursor, …) working in this repository. `CLAUDE.md` imports it. Read it fully before your first change in a session.

---

## 1. What we are building (30-second version)

**Business Finder** finds local businesses (by prompt, category and area), enriches and audits them, scores how likely they are to buy web/AI services, generates a **preview website** for chosen businesses with AI coding agents, and runs **compliant** email outreach that links to that preview. Primary deployment: Saint-Barthélemy (FR/EN), but everything is location-agnostic.

Read in this order when you need context: `docs/PRD.md` → `docs/ARCHITECTURE.md` → `docs/DOMAIN.md` → relevant `docs/adr/*` → your ticket in `docs/tickets/`.

## 2. Golden rules

1. **Work from a ticket.** Every change maps to a ticket `BF-NNN` in `docs/tickets/`. Read the whole ticket, its `depends_on` tickets (they are merged — reuse their code) and skim its `blocks` tickets (do not paint them into a corner).
2. **Stay in scope.** Implement exactly the ticket's *In scope* list. If you discover necessary out-of-scope work, write it under *Follow-ups* in the PR description instead of doing it.
3. **Contracts first.** Shared shapes live in `@bf/contracts` (Zod). Define/extend the schema, then implement against it. Never duplicate a type that exists there.
4. **Tests are part of the feature.** No PR without tests that would fail if the feature broke. Prefer writing the test first for domain logic.
5. **Verify before claiming done.** Run `pnpm verify` (and `uv run task verify` for Python) and paste the summary into the PR. Do not say "should work" — run it.
6. **No secrets, no PII in code, logs, fixtures or commits.** This repository is public. Use `.env` (git-ignored) and the secrets vault. Fixtures use fake data only.
7. **Compliance gate is mandatory.** Any code path that sends a message to a prospect MUST go through `ComplianceService.evaluate()` and the outbound pipeline. There is no "quick send" bypass, not even in scripts or seeds.
8. **Crawled content is untrusted.** Website text, reviews and provider payloads may contain prompt-injection. Never put them in a system prompt; wrap them as quoted data (see `docs/conventions/ai-engineering.md`).
9. **Do not trust your memory for library APIs.** Versions move fast. Check current docs (Context7 MCP if available, otherwise the official docs) before using an API you have not seen in this repo, and pin versions in the lockfile.
10. **Ask through the PR, not by guessing.** If the ticket is ambiguous and the choice is costly to reverse, implement the safest reasonable option, document the assumption in the PR under *Decisions & assumptions*, and flag it for review.

## 3. Repository map & dependency rules

```
apps/web        Next.js dashboard          (depends on: @bf/ui, @bf/contracts, @bf/auth (client), generated API client)
apps/api        NestJS HTTP + worker       (depends on: any @bf/* package except ui/site-blocks)
apps/sites      Next.js site renderer      (depends on: @bf/site-schema, @bf/site-blocks, @bf/contracts, read-only @bf/db)
services/intel  Python FastAPI             (depends on: generated Pydantic models from @bf/contracts JSON Schema)
services/agent-runner  Sandbox image       (contains: claude, codex, @bf/sitekit)
packages/*      Shared libraries           (@bf/<name>)
```

Hard rules (enforced by lint where possible):

- `apps/*` never import from another `apps/*`.
- `packages/*` never import from `apps/*`.
- `@bf/contracts` imports nothing internal (it is the leaf).
- Domain code (`modules/*/domain`) imports no framework (no Nest, no Drizzle, no HTTP clients).
- Only `apps/api` writes to the database. `apps/sites` uses a read-only DB role. `services/intel` never touches the DB; it is a stateless compute service called over HTTP.

## 4. Commands

These are created by BF-001/BF-002 and must keep working. If a command you need does not exist yet, add it to the root `package.json` as part of your ticket.

| Task | Command |
|---|---|
| Install | `pnpm install` |
| Start infrastructure | `pnpm infra:up` / `pnpm infra:down` / `pnpm infra:reset` |
| Run everything in dev | `pnpm dev` |
| Lint + typecheck + unit tests (all) | `pnpm verify` |
| Only affected packages | `pnpm turbo run lint typecheck test --filter=...[origin/main]` |
| Integration tests (Testcontainers) | `pnpm test:int` |
| E2E (Playwright) | `pnpm e2e` |
| DB: generate migration from schema | `pnpm db:generate --name <snake_name>` |
| DB: apply migrations / seed | `pnpm db:migrate` / `pnpm db:seed` |
| Regenerate OpenAPI + web client | `pnpm api:codegen` |
| Regenerate Python models from contracts | `pnpm contracts:py` |
| Python checks (in `services/intel`) | `uv run task verify` (ruff, mypy, pytest) |
| LLM evals (manual / nightly, costs money) | `pnpm eval --filter=@bf/ai` |

## 5. How to work a ticket

1. `git switch -c bf-0nn-short-slug` from an up-to-date `main`.
2. Read the ticket, its dependencies, the docs/ADRs it links. Inspect the existing code it touches.
3. Write a short plan (5–15 bullets) as the first section of your PR description draft. For L-sized tickets, split into stacked PRs (`part 1/2`) along the plan.
4. Contracts → domain (with unit tests) → application/use-cases → infrastructure adapters (with integration tests) → interface (HTTP/UI) → wiring → docs.
5. Run `pnpm verify` (+ `pnpm test:int` if you touched DB/queues, + `pnpm e2e` if you touched user flows).
6. Self-review with the checklist in §9. In Claude Code you can delegate to the `code-reviewer` and `security-reviewer` subagents.
7. Update docs: ticket checkboxes, `docs/ARCHITECTURE.md` / `docs/DOMAIN.md` if a concept changed, a new ADR if a decision changed.
8. Commit with Conventional Commits (`feat(scoring): add explainable profile engine (BF-031)`), push, open a PR titled `BF-0NN: <ticket title>` using the PR template.

## 6. Architecture conventions (summary — details in docs/ARCHITECTURE.md)

**NestJS module anatomy** (`apps/api/src/modules/<context>/`):

```
domain/          Entities, value objects, domain services, domain events, errors. Pure TypeScript.
application/     Use cases (commands & queries), ports (interfaces), mappers. No framework imports except DI tokens.
infrastructure/  Adapters: Drizzle repositories, HTTP clients, queue producers/processors, cache.
interface/       Controllers (REST), SSE endpoints, job processors registration, request/response DTO mapping.
<context>.module.ts
```

**Patterns we use deliberately**: Ports & Adapters (hexagonal), CQRS-lite (separate command/query use cases), Repository + Unit of Work (transactions via `TransactionContext` in AsyncLocalStorage), Domain Events + Transactional Outbox, Strategy (providers, engines, scoring transforms), Adapter (external APIs), Factory/Registry (engines, providers), explicit State Machines (typed transition tables) for lifecycles, Specification (filters, gates), Chain of Responsibility (quality gates, enrichment steps), Decorator (caching/rate-limiting/retry around ports), Circuit Breaker + retry with jitter (`cockatiel`) for every external call.

**Errors**: domain errors are typed classes (`BusinessNotFoundError extends DomainError`), mapped once to RFC 9457 `application/problem+json` by the global exception filter. Do not throw raw `Error` across layers. Use `Result<T, E>` for expected failures inside domain/application code where it reads better than exceptions.

**IDs & time**: UUIDv7 everywhere (`newId()` from `@bf/contracts`). Timestamps are `timestamptz`, ISO-8601 in JSON, always UTC. Inject a `Clock`; never call `Date.now()` in domain code.

**Idempotency**: every job handler and every external side effect has an idempotency key. Re-running a job must be safe.

**Configuration**: all env vars are declared and validated with Zod in `@bf/config`. No `process.env.X` outside config modules. Model IDs, concurrency limits and feature flags are configuration, not constants.

## 7. Testing rules (details in docs/conventions/testing.md)

- Unit tests next to code: `*.test.ts` (Vitest) / `test_*.py` (pytest). Domain logic: aim ≥ 90% branch coverage; packages overall ≥ 80% lines.
- Integration tests use **Testcontainers** (real Postgres with PostGIS+pgvector, real Valkey). Never mock the database.
- External HTTP is mocked at the boundary: MSW (TS) / respx (Python). Recorded fixtures live in `__fixtures__/`.
- LLM calls in tests use the `fake` provider from `@bf/ai/testing` with recorded responses. Real-model evals run only via `pnpm eval`.
- E2E (Playwright) covers the critical journeys listed in `docs/PRD.md` §6.
- No sleeps in tests; use fake timers or polling helpers with timeouts. Flaky tests are bugs.

## 8. Security & compliance invariants

- AuthZ: every API handler declares its permission (`@RequirePermission('business:read')`). Every org-scoped query filters by `organization_id` from the authenticated context, never from the request body.
- Secrets: provider API keys and mailbox credentials live in the encrypted secrets vault (`workspace` module). They are never returned to the client and never logged (the logger redacts known paths).
- Outbound HTTP to user-supplied or crawled URLs goes through `SafeHttpClient` (SSRF guard: blocks private/link-local/metadata IPs, re-checks after DNS resolution and redirects).
- Coding agents run only inside the sandbox runner (`services/agent-runner`): no DB access, no internal network, egress allowlist, per-run model key with budget.
- Outreach: compliance decision logged for every send; unsubscribe honoured immediately across all mailboxes and sequences; suppression checked at enqueue **and** at send time.

## 9. Self-review checklist (run before opening a PR)

- [ ] Ticket acceptance criteria all met; out-of-scope items not touched.
- [ ] Contracts updated in `@bf/contracts`; OpenAPI/Python models regenerated if affected.
- [ ] Tests: happy path, edge cases, failure modes, authz (403 for wrong org/role), idempotency where relevant.
- [ ] No `any`, no `@ts-ignore`, no `eslint-disable`/`biome-ignore` without a one-line justification.
- [ ] Errors are typed and mapped; external calls have timeouts, retries and circuit breakers.
- [ ] Logs are structured, carry correlation IDs, contain no secrets/PII.
- [ ] Migrations are forward-only and safe on a populated table (expand/contract).
- [ ] UI: loading, empty, error states; keyboard accessible; i18n keys (EN + FR) added.
- [ ] Docs/ADRs updated; ticket checkboxes ticked.
- [ ] `pnpm verify` green (paste summary in PR).

## 10. Definition of Done (applies to every ticket)

A ticket is done when: all acceptance criteria pass; tests exist and pass in CI; lint/typecheck are clean; observability (logs, traces, metrics where the ticket says so) is in place; docs are updated; the PR is reviewed and merged to `main`; and the GitHub issue is closed with a link to the PR.

## 11. When you are unsure

- Missing information that blocks correctness → make the conservative choice, write it under *Decisions & assumptions* in the PR, and add a `// DECISION(BF-0NN): …` comment at the spot.
- A library does not behave as the ticket assumes → follow the current official docs, note the discrepancy in the PR.
- Ticket conflicts with an ADR → the ADR wins; propose an ADR change in the PR rather than silently diverging.
