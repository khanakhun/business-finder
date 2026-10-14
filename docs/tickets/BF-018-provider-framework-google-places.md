---
id: BF-018
title: Discovery provider framework and Google Places (New) provider
milestone: M1 Find & List
epic: discovery
type: feature
priority: P0
size: M
depends_on: [BF-011, BF-016, BF-017]
blocks: [BF-019, BF-020]
areas: [api, worker]
---

# BF-018 — Discovery provider framework and Google Places (New) provider

## Context
Discovery queries external sources for categories × area tiles and feeds source records into ingestion (BF-016). Providers differ in capabilities, cost and licensing ([ADR-0013](../adr/0013-discovery-providers-and-data-licensing.md)). Google Places API (New) is the highest-coverage official source; pricing uses per-SKU free caps and tiered field masks (since March 2025: free monthly thresholds of 10k Essentials / 5k Pro / 1k Enterprise calls; Text Search Pro ≈ $32/1k; requesting ratings/hours moves calls to Enterprise ≈ $35/1k; reviews/photos ≈ $40/1k — **verify current pricing and terms at implementation time**). Keys come from the secrets vault (BF-011).

## Goal
A typed provider framework (capabilities, licensing, cost estimation, rate limits, usage metering, connection tests) and a production-quality Google Places provider using Text Search / Nearby Search with deliberate field masks, pagination, language/region handling and licensing-aware retention.

## Scope
**In scope**
- `@bf/contracts` discovery types: `ProviderId`, `ProviderCapabilities` (`textQuery`, `categoryFilter`, `circle`, `bbox`, `polygon`, `maxResultsPerQuery`, `pagination`), `ProviderLicensing` (`retentionDays|null`, `storableFields[]`, `attributionRequired`, `attributionText`, `commercialUseAllowed`, `notes`), `ProviderCostModel` (`perCallUsd` by tier, `perResultUsd?`, `freeMonthlyCalls?` by SKU), `ProviderQuery` (`categoryIds`, `providerKeys`, `tile` (circle|bbox), `keywords?`, `languageCode`, `regionCode`, `pageToken?`), `ProviderPage { records: SourceRecord[], nextPageToken?, callCostUsd, sku }`.
- `discovery` module infrastructure:
  - `DiscoveryProvider` port: `id`, `capabilities`, `licensing`, `costModel`, `buildQueries(intent, tile)`, `fetchPage(query, ctx, signal)`, `estimateCost(plan)`, `testConnection(orgId)`.
  - `ProviderRegistry` + `ProviderSelectionPolicy` (Strategy): picks providers for an intent based on workspace preference order (setting in `org_settings.discovery`), capability fit, feature flags, configured secrets, and budget.
  - `ProviderUsageMeter`: table `provider_usage` (`organization_id`, `provider`, `sku`, `day`, `calls`, `results`, `cost_usd`), monthly aggregation; free-tier awareness (cost becomes non-zero after free caps — configurable).
  - Rate limiting per provider/key (Valkey token bucket) and resilience policies (timeouts, retries on 429/5xx with backoff honoring `Retry-After`, circuit breaker).
  - Category → provider key mapping using `category_mappings` (BF-015) reverse lookup.
  - `FakeDiscoveryProvider` (enabled only when `NODE_ENV=test` or `E2E=true`) returning fixture records for BL — used by E2E tests in BF-023.
- `GooglePlacesProvider`:
  - Text Search (`places:searchText`) with `includedType` (one primary type per query), `locationRestriction.rectangle` for bbox tiles or `locationBias.circle` for circles (verify which restriction modes each endpoint supports), `languageCode`, `regionCode`, `pageSize`, `pageToken` pagination (up to the endpoint's max results).
  - Nearby Search (`places:searchNearby`) with `includedTypes`, circle restriction, `rankPreference=DISTANCE` for dense tiles (max 20 results; signals "tile full" to the planner).
  - Field masks configurable by tier: `essentials|pro|enterprise` presets (e.g. Pro: `places.id,places.displayName,places.formattedAddress,places.location,places.types,places.primaryType,places.businessStatus,places.googleMapsUri`; Enterprise adds `websiteUri,nationalPhoneNumber,internationalPhoneNumber,rating,userRatingCount,regularOpeningHours,priceLevel`) — default chosen by workspace setting with cost shown in the UI estimate.
  - Mapping to `SourceRecord` (address components → our address shape; types → provider categories; business status → operating status).
  - Licensing profile per the **current** Google Maps Platform terms (verify): which fields may be stored and for how long (place IDs storable indefinitely; other content limited caching) → `expiresAt`; attribution text; review/photo content **not** stored by default.
  - `testConnection` (cheap call with minimal field mask) registered with BF-011's tester registry for secret `google_places_api_key`.
- Admin/API: `GET /v1/discovery/providers` (available providers for this workspace with status: configured, enabled, cost model summary, licensing summary), `GET /v1/discovery/usage?from&to` (`settings:manage`).

**Out of scope**
- Overture/Foursquare/OSM/scraper providers (→ BF-019). Run orchestration, tiling plans and budgets per run (→ BF-020). Place Details enrichment calls (not needed initially; can be added behind a flag later).

## Requirements
### Functional
- Each Google call records usage with SKU and estimated cost; a missing key yields `ProviderNotConfiguredError` naming the secret.
- Records from Google carry `expiresAt` per licensing profile; review/photo bodies are not persisted.
### Non-functional
- Contract tests with recorded (scrubbed) Google responses; no live calls in CI.
- Provider code isolated behind the port; adding a provider requires no change to orchestration.

## Design
```
modules/discovery/
├── domain/{provider.port.ts, selection-policy.ts, cost.ts}
├── infrastructure/providers/google-places/{client.ts, field-masks.ts, mapper.ts, licensing.ts, provider.ts}
├── infrastructure/providers/fake/{provider.ts, fixtures/*.json}
├── infrastructure/{provider-registry.ts, usage-meter.ts, rate-limiter.ts}
└── interface/http/{providers.controller.ts, usage.controller.ts}
```
- Patterns: Strategy (providers, selection), Adapter (Google client), Decorator (rate limit/resilience/metering around `fetchPage`), Registry.

## Implementation plan
1. Verify current Places API (New) endpoints, request shapes, field-mask SKUs, pagination limits, pricing and caching/retention terms; summarize them in `providers/google-places/README.md` with links and date checked.
2. Contracts + port + registry + selection policy + usage meter (unit tests).
3. Google client + mapper + field masks + licensing (contract tests with fixtures).
4. Rate limiting + resilience decorators.
5. Fake provider + fixtures.
6. APIs + connection tester registration.

## Testing
- Unit: selection policy (preference order, missing key, disabled flag, budget exhausted), cost estimation by tier and free caps, mapper (address components, status, types), licensing expiry calculation.
- Contract: recorded Text Search and Nearby responses → normalized records snapshot.
- Integration: usage meter aggregation; rate limiter behavior under burst (fake clock).

## Acceptance criteria
- [ ] Provider framework with capabilities, licensing, cost model, selection policy, rate limiting, resilience and usage metering.
- [ ] Google Places provider (Text + Nearby) with tiered field masks, pagination, mapping and licensing-aware retention.
- [ ] Connection test for the Google key in Settings → Integrations.
- [ ] Fake provider for tests/E2E.
- [ ] `providers/google-places/README.md` documents verified pricing/terms with date.

## Agent prompt
```text
Implement BF-018 (Discovery provider framework and Google Places (New) provider).

Read first: AGENTS.md, docs/adr/0013-discovery-providers-and-data-licensing.md, docs/ARCHITECTURE.md §7 and §8 (F2),
docs/DOMAIN.md (Provider, Source record). Reuse: SourceRecord + ingestion (BF-016), category mappings (BF-015),
tiling types (BF-017), SecretResolver + connection tester registry (BF-011).

Rules:
- Read the current Google Maps Platform Places API (New) docs, pricing page and service-specific terms before
  coding; encode retention/caching rules in the licensing profile and document them with the date checked.
- Minimize cost by design: the cheapest field mask that serves the use case; show cost estimates.
- No live API calls in tests; record and scrub fixtures (no API keys, no personal data).

Verify: pnpm verify && pnpm test:int. With a real key (optional, local), run one Text Search for "cafe" in the
BL bbox and paste the normalized record count and recorded cost.
```

## References
- ADR-0013 · docs/ARCHITECTURE.md §8 (F2)
- Places API (New): https://developers.google.com/maps/documentation/places/web-service/op-overview · Text Search: https://developers.google.com/maps/documentation/places/web-service/text-search · Nearby Search: https://developers.google.com/maps/documentation/places/web-service/nearby-search · Pricing: https://developers.google.com/maps/billing-and-pricing/pricing · Policies: https://developers.google.com/maps/documentation/places/web-service/policies
