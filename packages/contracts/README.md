# @bf/contracts

The shared language of every app and service: Zod schemas and the types derived from them. Everything else
depends on this package; it depends on nothing internal (only `zod` and `uuid`) and uses Web APIs only, so it runs
in Node, browsers and edge runtimes. Biome enforces both rules for `src/` (`noNodejsModules`, no `@bf/*` imports).

| Module | What it provides |
|---|---|
| `ids.ts` | `newId()` (UUIDv7, monotonic), `idSchema(brand)`, branded `OrgId`, `UserId`, `BusinessId`, `SiteId`, `EventId` |
| `result.ts` | `Result<T, E>`, `ok`, `err`, `map`, `mapErr`, `andThen`, `unwrapOr`, `fromPromise` |
| `errors.ts` | `ERROR_CODES` registry, `DomainError` + subclasses, `toProblem()`, `ProblemDetailsSchema` (RFC 9457) |
| `pagination.ts` | `CursorPageRequestSchema`, `cursorPage(item)`, `encodeCursor` / `decodeCursor` (optional HMAC) |
| `i18n.ts` | `LocaleSchema` (`fr`, `en`), `LocalizedTextSchema`, `pickLocale()` |
| `geo.ts` | `LatLngSchema`, `BBoxSchema`, GeoJSON `PolygonSchema` / `MultiPolygonSchema`, `CountryCodeSchema` |
| `events.ts` | Domain event envelope, `defineEvent(type, version, payload)` registry |
| `jobs.ts` | `JobPayloadBase`, `defineJob(queue, name, shape)` registry |
| `permissions.ts` | Roles, permissions, `ROLE_PERMISSIONS`, `can()` (also `@bf/contracts/permissions`) |
| `time.ts` | `Clock`, `systemClock`, `fixedClock()`, `IsoDateTimeSchema` (UTC only) |
| `realtime.ts` | `RealtimeEventSchema` base for SSE |
| `registry.ts` | `exportSchema()` + JSON Schema export for other languages (also `@bf/contracts/registry`) |

## Adding things

**A schema.** Put it in the module of its feature (create `src/<feature>.ts` and re-export from `index.ts`).
Export both the schema and its type with the same name pattern: `FooSchema` + `type Foo = z.infer<typeof FooSchema>`.
API-facing schemas get OpenAPI metadata so BF-006 emits named components:

```ts
export const BusinessSummarySchema = z
  .object({ id: BusinessId, name: z.string() })
  .meta({ id: 'BusinessSummary', description: 'A business in list views.', examples: [{ id: '…', name: 'Le Tamarin' }] });
```

Call `.meta()` / `.describe()` **last** — Zod methods return new instances and metadata does not carry over.
The exception is `.brand()`, which is type-only and must be the very last call (see `idSchema`).

**A branded id.** `export const SiteVersionId = idSchema('SiteVersionId'); export type SiteVersionId = Id<'SiteVersionId'>;`

**An error.** Add the code to `ERROR_CODES` (`<CONTEXT>_<REASON>`, e.g. `BUSINESS_NOT_FOUND: { status: 404, title: … }`),
then a subclass with `readonly code = 'BUSINESS_NOT_FOUND'`. Never use a string code that is not in the registry.
`toProblem()` hides the message of 5xx errors.

**An event.** `export const BusinessCreated = defineEvent('business.created', 1, z.object({ businessId: BusinessId }));`
Past tense, `context.entity[.detail]`; a breaking payload change is a new version, not an edit.

**A job.** `export const EnrichBusiness = defineJob('enrichment', 'enrich-business', { businessId: BusinessId });`
The payload automatically includes `idempotencyKey`, `orgId`, `traceparent?`, `requestedBy?`.

**A permission.** Add it to `PERMISSIONS` and to the right role lists in `permissions.ts` (and DOMAIN.md §5).
Tests enforce that owner has everything and viewer only `*:read`.

**A cross-language schema.** Opt in with `exportSchema(schema, { id: 'SiteIntelRequest', exportTo: ['python'] })`
in `registry.ts` (or next to the schema, imported by `registry.ts`), then run `pnpm contracts:jsonschema`. Files
land in `generated/jsonschema/<target>/<Id>.json` (draft 2020-12, sorted keys, `$id`); commit them. BF-008
generates Pydantic models from them. `pnpm contracts:jsonschema --check` fails when they are stale.

## Cursors

`encodeCursor({ sort: [lastItem.score, lastItem.name], id: lastItem.id }, { secret })` → opaque base64url string;
`decodeCursor(cursor, { secret })` throws `ValidationError` (422) for malformed or tampered input. Pass the API's
cursor secret so clients cannot forge positions. Both are async (Web Crypto).
