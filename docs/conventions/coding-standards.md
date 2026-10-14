# Coding standards

These rules exist so that code written by different agents and humans looks like one author wrote it. Lint enforces what it can; reviewers enforce the rest.

## 1. TypeScript

**Compiler** (`@bf/tsconfig/base.json`): `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `useUnknownInCatchVariables`, `verbatimModuleSyntax`, `isolatedModules`, target ES2023, module `NodeNext` (libraries/Nest) or `Bundler` (Next.js).

**Naming**
- Files: `kebab-case.ts`; NestJS suffixes: `*.module.ts`, `*.controller.ts`, `*.service.ts`, `*.repository.ts`, `*.processor.ts`, `*.command.ts`, `*.query.ts`, `*.entity.ts`, `*.vo.ts`, `*.events.ts`, `*.errors.ts`; tests `*.test.ts` (unit) and `*.int.test.ts` (integration).
- Types/classes `PascalCase`; functions/variables `camelCase`; true constants `SCREAMING_SNAKE_CASE`; booleans read as predicates (`isPublished`, `hasWebsite`).
- No TypeScript `enum`. Use `as const` objects + union types, or `z.enum([...])` from contracts.

**Modules & exports**
- Named exports only (Next.js route files are the exception: `page.tsx`, `layout.tsx`, `route.ts` use the required default/named conventions).
- Barrel `index.ts` only at a package root or a NestJS module's public surface. Never re-export internals "for convenience".
- No circular imports (checked by `madge`/`dpdm` in CI).

**Types**
- No `any`. Use `unknown` + narrowing (Zod parse or type guards). `as` casts require a comment explaining why they are safe.
- Branded IDs from `@bf/contracts` (`BusinessId`, `OrgId`, …). Never pass a bare `string` where a branded id exists.
- Prefer `readonly` properties and `ReadonlyArray` in domain types; return new objects instead of mutating inputs.
- Model optional vs nullable deliberately: `field?: T` = may be absent; `field: T | null` = known to be empty.

**Errors**
- Domain/application errors extend `DomainError` (`code`, `message`, optional `details`, `httpStatus` hint). Codes are stable, `SCREAMING_SNAKE` (`BUSINESS_NOT_FOUND`).
- Expected failures inside domain/application may use `Result<T, E>` (`ok()/err()` from `@bf/contracts`). Do not mix styles within one function.
- Never swallow errors. Catch only to add context, translate, or handle; rethrow with `cause`.
- External calls: always timeout + retry policy + circuit breaker via `@bf/platform/resilience` decorators.

**Async**
- No floating promises (lint). Pass `AbortSignal` through long-running operations.
- Bounded concurrency for fan-out (`p-limit` or BullMQ), never unbounded `Promise.all` over user-sized input.
- No `setTimeout`-based retries in business code; use the resilience policies or queue retries.

**Time, money, text**
- Store/compute in UTC; format at the edge with `Intl`. Inject `Clock`.
- Costs in USD as `number` of micro-dollars (integer) in memory; `numeric(12,6)` in SQL.
- All user-visible strings in the dashboard go through `next-intl` with EN and FR messages.

**Comments & TODOs**
- Comments explain *why*, not *what*. Public functions in packages get TSDoc.
- `TODO(BF-0NN): …` must reference a ticket. `DECISION(BF-0NN): …` marks a documented assumption.

## 2. NestJS (`apps/api`)

- Controllers: parse/authorize/delegate only. No business logic, no repository calls.
- Use cases (`*.command.ts`, `*.query.ts`) are injectable classes with a single `execute(input, ctx)` method.
- Ports are TypeScript interfaces + DI tokens (`export const BUSINESS_REPOSITORY = Symbol('BusinessRepository')`). Adapters implement ports and live in `infrastructure/`.
- Domain classes are framework-free and constructed through factories (`Business.create(...)`, `Business.rehydrate(...)`).
- Every processor (`@Processor`) delegates to a use case; processors handle only job plumbing (progress, cancellation, idempotency).
- Guards and decorators: `@RequirePermission()`, `@AllowAnonymous()`, `@OrgContext()`; never read headers for org/user directly.

## 3. Next.js (`apps/web`, `apps/sites`)

- Server Components by default; `'use client'` only for interactivity. Keep client bundles small (no heavy libs in shared layouts).
- Dashboard data: TanStack Query hooks generated/wrapped around the typed API client; mutations invalidate by query keys defined in one place (`lib/query-keys.ts`).
- URL is the state for search/filters/sort/pagination (`nuqs`), so views are shareable and restorable.
- Forms: `react-hook-form` + `zodResolver` with schemas from `@bf/contracts`.
- UI primitives from `@bf/ui` (shadcn/ui based). No ad-hoc copies of components.
- Every async view has loading (skeleton), empty and error states; errors show the problem+json `title`/`detail`.
- Accessibility: semantic HTML, labelled controls, focus management in dialogs, keyboard shortcuts documented in the command palette.

## 4. Python (`services/intel`)

- Python 3.13, `ruff` (lint + format), `mypy --strict`, `pytest`.
- FastAPI routers per feature (`app/routers/site_intel.py`), service classes for logic (`app/services/...`), adapters for external libs (`app/adapters/...`).
- Pydantic v2 models: request/response models are **generated** from `@bf/contracts` JSON Schema into `app/contracts/` — do not edit generated files.
- Async I/O (`httpx.AsyncClient`, Playwright async API); CPU-bound work in a process pool.
- Configuration via `pydantic-settings`; no `os.environ` reads elsewhere.
- Logging via `structlog` JSON with trace context.

## 5. SQL & database

- Tables `snake_case` plural (`business_contacts`); columns `snake_case`; FK `<entity>_id`.
- Index names: `idx_<table>__<col1>_<col2>`; unique: `uq_<table>__<cols>`; check: `ck_<table>__<rule>`.
- Every org-scoped table: `organization_id` first column of the leading composite index.
- Prefer `timestamptz`, `text` (with check constraints for length if needed), `jsonb`, `citext` for emails.
- Queries live in repositories; complex read queries may live in `*.sql.ts` files using Drizzle's `sql` tag with typed result mappers.

## 6. Dependencies

- Add a dependency only when it removes meaningful complexity; prefer well-maintained, typed, permissively licensed packages. Note the reason in the PR.
- Pin exact versions via the lockfile; keep framework majors aligned across workspaces (`syncpack` or pnpm catalogs).
- No packages with install scripts that download binaries at runtime unless required (Playwright, sharp are accepted).
