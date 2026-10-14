# API conventions

## 1. Basics

- Base path `/v1`; JSON (`application/json; charset=utf-8`); field names `camelCase`; timestamps ISO-8601 UTC; IDs UUIDv7 strings.
- Resources are plural nouns in kebab-case (`/v1/generation-batches`). Actions that are not CRUD use a sub-resource verb with POST (`POST /v1/discovery-runs/:id/cancel`).
- Every request and response body has a Zod schema in `@bf/contracts`. The OpenAPI 3.1 document is generated from those schemas (`pnpm api:codegen`) and the web client is generated from the OpenAPI document. Never hand-write API types in the web app.

## 2. Auth and context

- Session cookie (Better Auth) or `Authorization: Bearer bf_<key>` (API key).
- Organization context = session's active organization or the API key's organization. Never accept `organizationId` in bodies for authorization.
- Handlers declare permissions with `@RequirePermission('…')`. Missing permission → 403 problem with `code: FORBIDDEN`. Resource in another org → 404 (do not leak existence).

## 3. Lists, filtering, sorting, pagination

- Cursor pagination: `?limit=50&cursor=<opaque>`; response `{ items, nextCursor, totalEstimate? }`. Cursors are opaque base64url encodings of the sort key + id; never offsets for large tables.
- Filters as query params validated by Zod: repeated keys for multi-values (`?category=hair-salon&category=cafe`), ranges with bracket operators (`?rating[gte]=4&reviews[lte]=50`), booleans as `true|false`, geo as `?area=<areaId>` or `?near=lat,lng&radiusKm=5`.
- Sorting: `?sort=-score,name` (comma-separated, `-` = descending), whitelisted per resource.
- Facets: separate endpoint `GET /v1/businesses/facets?<same filters>` to keep list responses cacheable.

## 4. Errors (RFC 9457)

```json
{
  "type": "https://errors.business-finder.dev/BUSINESS_NOT_FOUND",
  "title": "Business not found",
  "status": 404,
  "detail": "No business with id 0192f… in this workspace.",
  "instance": "/v1/businesses/0192f…",
  "code": "BUSINESS_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "errors": [{ "path": ["rating", "gte"], "message": "Must be between 0 and 5" }]
}
```

- `code` values are stable and listed in `@bf/contracts/errors.ts`. Validation errors use 422 with `errors[]`.
- 5xx responses never leak stack traces or internal messages.

## 5. Idempotency

- POST endpoints with side effects (send message, create batch, start discovery, publish) accept `Idempotency-Key` (UUID). The first response is stored for 24h in Valkey keyed by `(orgId, route, key)`; replays return the stored response with header `Idempotent-Replayed: true`. A different body with the same key → 409.

## 6. Long-running operations

- Return `202 Accepted` with the created resource (`{ id, status: 'queued', … }`) and `Location`. Clients follow progress via SSE or polling the resource.

## 7. Server-Sent Events

- `GET /v1/realtime` (org stream) and resource streams like `GET /v1/generation-jobs/:id/events`.
- Format: `id: <eventId>` / `event: <type>` / `data: <json>`; heartbeat comment every 15 s; honour `Last-Event-ID` (resource streams replay persisted events after that id).
- Event payloads are Zod schemas in `@bf/contracts/realtime.ts`.

## 8. Rate limiting

- Per user + per org + per IP for public routes; headers `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`; 429 problem with `Retry-After`.

## 9. Public endpoints

- `/v1/public/*` (site leads, view beacons, unsubscribe) are unauthenticated, strictly rate-limited, CORS-restricted to the sites domain where applicable, and validate HMAC-signed tokens (unsubscribe) or signed site ids (leads/views).

## 10. Webhooks (inbound)

- Gmail Pub/Sub push: verify the JWT (audience, issuer) before processing. Microsoft Graph: handle `validationToken` handshake and verify `clientState`. All webhook handlers enqueue work and return 2xx quickly.

## 11. Versioning and deprecation

- Breaking changes require `/v2` of the affected resource or an additive change. Deprecated fields are marked in the schema description and removed after the web client stops using them.
