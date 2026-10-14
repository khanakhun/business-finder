---
id: BF-004
title: Shared contracts, error model and cross-language schemas
milestone: M0 Foundations
epic: foundations
type: feature
priority: P0
size: M
depends_on: [BF-001]
blocks: [BF-006, BF-008, BF-013, BF-014, BF-033]
areas: [contracts]
---

# BF-004 — Shared contracts, error model and cross-language schemas

## Context
"Schemas are the contract" ([ARCHITECTURE.md §1](../ARCHITECTURE.md#1-principles)): every DTO, event, job payload and error lives as a Zod schema in `@bf/contracts`, from which OpenAPI (web client) and JSON Schema → Pydantic (Python service) are generated. This package is the leaf of the dependency graph; nearly every later ticket extends it.

## Goal
`@bf/contracts` exists with the primitives every module needs — branded IDs and UUIDv7 generation, `Result`, the `DomainError` hierarchy and error-code registry, RFC 9457 problem schema, cursor pagination, i18n text, geo primitives, event envelope, job payload base, permission matrix, clock interface — plus a deterministic JSON Schema export registry for cross-language code generation.

## Scope
**In scope**
- Zod v4 as the schema library (verify the current major and its JSON Schema/metadata APIs).
- Modules:
  - `ids.ts` — `newId()` (UUIDv7 via a vetted library), `Id<Brand>` branded type helper, schemas `OrgId`, `UserId`, `BusinessId`, `SiteId`, … (add more in later tickets), `isUuidV7()`.
  - `result.ts` — `Result<T, E>`, `ok`, `err`, `isOk`, `map`, `mapErr`, `andThen`, `unwrapOr`, `fromPromise`.
  - `errors.ts` — `DomainError` (abstract: `code`, `httpStatus`, `message`, `details?`, `cause?`), common subclasses (`NotFoundError`, `ValidationError`, `ConflictError`, `ForbiddenError`, `InvalidStateTransitionError`, `RateLimitedError`, `ExternalServiceError`, `BudgetExceededError`), `ErrorCode` registry (const object, stable `SCREAMING_SNAKE` codes), `ProblemDetailsSchema` (RFC 9457 + `code`, `traceId`, `errors[]`).
  - `pagination.ts` — `CursorPageRequestSchema` (`limit` 1–200 default 50, `cursor?`), `cursorPage(itemSchema)` response factory, `encodeCursor({ sort: unknown[], id })` / `decodeCursor` (base64url JSON, validated, tamper-resistant via HMAC optional param).
  - `i18n.ts` — `LocaleSchema` (`'fr' | 'en'` initially, extensible), `LocalizedTextSchema` (`Partial<Record<Locale,string>>` with at-least-one refinement), helpers `pickLocale(text, preferred[], fallback)`.
  - `geo.ts` — `LatLngSchema` (lat −90..90, lng −180..180), `BBoxSchema`, GeoJSON `PolygonSchema` / `MultiPolygonSchema` (ring closure and minimum points validated), `CountryCodeSchema` (ISO-3166-1 alpha-2 incl. `BL`, `MF`).
  - `events.ts` — `DomainEventEnvelope<TType, TPayload>` schema factory: `{ id, type, version, occurredAt, orgId|null, actor:{type,id|null}, correlationId, causationId|null, payload }`, `defineEvent(type, version, payloadSchema)` registry.
  - `jobs.ts` — `JobPayloadBase` (`idempotencyKey`, `orgId|null`, `traceparent?`, `requestedBy?`), `defineJob(queue, name, payloadSchema)` registry.
  - `permissions.ts` — `Role` (`owner|admin|member|viewer`), `Permission` union (from DOMAIN.md §5, extended later), `ROLE_PERMISSIONS` matrix, `can(role, permission)`.
  - `time.ts` — `Clock` interface (`now(): Date`), `IsoDateTimeSchema`.
  - `realtime.ts` — `RealtimeEventSchema` base (`{ id, type, entity, entityId, orgId, payload, at }`).
- JSON Schema export: `src/registry.ts` where schemas opt in with `.meta({ id: 'SiteIntelRequest', exportTo: ['python'] })`; script `pnpm contracts:jsonschema` writes `packages/contracts/generated/jsonschema/<id>.json` (stable key order, `$id`, `$schema` 2020-12) — used by BF-008 for Pydantic generation.
- OpenAPI metadata conventions (document in package README): every API-facing schema gets `meta({ id, description, examples })` so BF-006 can emit named components.
- Type tests with `expectTypeOf` (Vitest) for brands and `Result`.

**Out of scope**
- NestJS integration of the error filter and validation pipe (→ BF-006). Python model generation (→ BF-008). Feature-specific schemas (added by each feature ticket).

## Requirements
### Functional
- `newId()` produces RFC 9562 UUIDv7 strings; IDs generated in the same millisecond are monotonic.
- `decodeCursor` rejects malformed or tampered cursors with `ValidationError`.
- Permission matrix: every permission assigned to `owner`; `viewer` has only `*:read` permissions (test enforces).
### Non-functional
- Zero runtime dependencies besides `zod` and the UUIDv7 library; tree-shakeable ESM; no Node-only APIs (usable in browser and edge).

## Design
- Brand helper: `type Id<B extends string> = string & { readonly __brand: B }`; schemas: `export const BusinessId = z.uuid().brand<'BusinessId'>()` (adapt to Zod v4 API).
- `DomainError.toProblem(instance, traceId)` returns `ProblemDetails` (used by the API filter).
- Error code naming: `<CONTEXT>_<REASON>` (e.g. `BUSINESS_NOT_FOUND`, `COMPLIANCE_BLOCKED`), registry is the single list — adding a code = adding it here.
- Keep files small; `index.ts` re-exports the public surface; subpath exports for heavy registries (`@bf/contracts/permissions`).

## Implementation plan
1. Confirm Zod v4 APIs for brand, metadata and `toJSONSchema` in current docs.
2. Implement modules with unit + type tests (TDD for `Result`, cursor, permissions).
3. Implement registry + JSON Schema export script with a snapshot test of a sample schema.
4. Write `packages/contracts/README.md`: how to add schemas/events/jobs/errors/permissions, metadata conventions.

## Testing
- Unit: UUIDv7 format/monotonicity (generate 10k, assert sorted), `Result` combinators, cursor encode/decode/tamper, LocalizedText refinement, GeoJSON validation (open ring rejected), permission matrix invariants, problem conversion.
- Type tests: `BusinessId` not assignable to `SiteId`; `Result` narrowing.
- Snapshot: JSON Schema export deterministic across runs.

## Acceptance criteria
- [ ] All modules listed exist with tests; coverage ≥ 90% lines.
- [ ] `pnpm contracts:jsonschema` writes deterministic JSON Schema files for opted-in schemas.
- [ ] Package works in browser builds (no Node APIs) — verified by a tiny Vitest `environment: 'happy-dom'` import test.
- [ ] README documents conventions for adding schemas, events, jobs, errors and permissions.

## Agent prompt
```text
Implement BF-004 (Shared contracts, error model and cross-language schemas) in packages/contracts.

Read first: AGENTS.md, docs/ARCHITECTURE.md §1 and §5.3, docs/DOMAIN.md §4 and §5, docs/conventions/api.md §3–§5,
docs/conventions/coding-standards.md §1.

Rules:
- Use Zod v4; verify brand/metadata/JSON-Schema APIs in current docs before writing code.
- This package is the dependency leaf: no imports from other @bf packages, no Node-only APIs.
- TDD for Result, cursor and permissions. Add type-level tests for branded ids.
- Error codes are a single registry; never inline string codes elsewhere.

Verify: pnpm verify (coverage report for @bf/contracts ≥ 90%); run pnpm contracts:jsonschema twice and show no diff.
```

## References
- docs/ARCHITECTURE.md §1, §5.3 · docs/DOMAIN.md §4–§5 · docs/conventions/api.md
- RFC 9457 Problem Details: https://www.rfc-editor.org/rfc/rfc9457 · RFC 9562 (UUIDv7): https://www.rfc-editor.org/rfc/rfc9562
- Zod: https://zod.dev/
