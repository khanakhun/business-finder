# Google Places API (New) — verified facts

Checked: 2026-10-15

This file records what the official docs said on the date above. The provider implementation relies on it.
If you change any default (field mask preset, page limits, retention), re-check the sources first.

Sources:

- Text Search (New): https://developers.google.com/maps/documentation/places/web-service/text-search
- `places:searchText` reference: https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places/searchText
- Nearby Search (New): https://developers.google.com/maps/documentation/places/web-service/nearby-search
- Place resource reference: https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places
- Place data fields / SKU mapping: https://developers.google.com/maps/documentation/places/web-service/data-fields
- Usage and billing: https://developers.google.com/maps/documentation/places/web-service/usage-and-billing
- Pricing: https://developers.google.com/maps/billing-and-pricing/pricing
- Policies (attribution, caching): https://developers.google.com/maps/documentation/places/web-service/policies
- Place IDs: https://developers.google.com/maps/documentation/places/web-service/place-id
- Place types (Table A/B): https://developers.google.com/maps/documentation/places/web-service/place-types
- Service Specific Terms, §14 Places API: https://cloud.google.com/maps-platform/terms/maps-service-terms
- GMP Terms of Service, §3.2.3 restrictions: https://cloud.google.com/maps-platform/terms
- GMP FAQ (QPM limits): https://developers.google.com/maps/faq

## Endpoints

| Operation | Method + URL |
|---|---|
| Text Search | `POST https://places.googleapis.com/v1/places:searchText` |
| Nearby Search | `POST https://places.googleapis.com/v1/places:searchNearby` (POST only) |

Headers for both endpoints:

- `Content-Type: application/json`
- `X-Goog-Api-Key: <key>`. Keep the key server-side, never in the repo.
- `X-Goog-FieldMask: <comma-separated paths>` is **required**. Quote from the docs: "There is no default list of returned fields in the response. If you omit the field mask, the method returns an error." Spaces are not allowed anywhere in the list. `*` works but is discouraged in production.

### searchText request body

| Field | Notes |
|---|---|
| `textQuery` | Required. Not intended for ambiguous queries; lat/lng strings are unsupported. |
| `includedType` | One Table A type only ("Only support one included type"). By default it biases results; it does not filter them. |
| `strictTypeFiltering` | bool, default `false`. With `true`, only places matching `includedType` are returned. |
| `languageCode` | Default `en`. An invalid code returns `INVALID_ARGUMENT`. |
| `regionCode` | Two-character CLDR code. No default. Biases results and affects formatting. |
| `pageSize` | 1–20. 0 or unset means 20. Values above 20 are clamped to 20. |
| `maxResultCount` | **Deprecated**: "Use `pageSize` instead." If both are set, `maxResultCount` is ignored. |
| `pageToken` | `nextPageToken` from the previous response. All other params must be identical (except `pageSize`/`maxResultCount`/`pageToken`), otherwise `INVALID_ARGUMENT`. |
| `locationBias` | `circle` {`center`{latitude,longitude}, `radius` 0–50000 m} **or** `rectangle` {`low`,`high`}. Ignored if `textQuery` names an explicit place ("Market in Barcelona"). |
| `locationRestriction` | **`rectangle` only** (viewport `low`/`high`, no wider than 180°). No circle. Mutually exclusive with `locationBias`. |
| `rankPreference` | `RELEVANCE` (default for categorical queries) or `DISTANCE`. For non-categorical queries, leave it unset. |
| `openNow`, `minRating` (0–5 in 0.5 steps, rounded up), `priceLevels[]` (no `PRICE_LEVEL_FREE`), `includePureServiceAreaBusinesses`, `includeFutureOpeningBusinesses`, `evOptions` | Optional filters. Not used by our MVP. |

Response: `places[]`, `nextPageToken` (if absent or empty, there are no more pages), `searchUri`, plus `routingSummaries[]` and `contextualContents[]` (experimental), which we don't use.

**Pagination limits:** "Text Search (New) returns a maximum of **60 results across all pages**, although this limit is subject to change." That is at most 3 pages of 20. `nextPageToken` is only returned if it appears in the field mask: it is a response field, and the docs' examples always include it (`places.id,nextPageToken`). It belongs to the Essentials (IDs Only) field list, so it does not raise the SKU.

### searchNearby request body

| Field | Notes |
|---|---|
| `locationRestriction.circle` | **Required.** `center`{latitude,longitude} plus `radius` in metres, > 0 and ≤ 50,000. Circle only. |
| `includedTypes` / `excludedTypes` | Table A, up to 50 each. The same type in both lists is an error. |
| `includedPrimaryTypes` / `excludedPrimaryTypes` | Table A, up to 50 each. A conflict returns `INVALID_ARGUMENT`. |
| `maxResultCount` | 1–20, default 20. |
| `rankPreference` | `POPULARITY` (default) or `DISTANCE`. |
| `languageCode` / `regionCode` | Same semantics as Text Search. |
| `includeFutureOpeningBusinesses` | bool, default `false`. |

There is **no pagination** and no `nextPageToken`, so a query returns at most 20 results. To cover a bigger area, split it into several smaller circles.

### Location support summary

| | locationBias | locationRestriction |
|---|---|---|
| searchText | circle or rectangle | rectangle only |
| searchNearby | n/a | circle only (required) |

## Field mask presets (what we send)

Billing uses the **highest SKU triggered by any field** in the mask ("You are then billed at the highest SKU applicable to your request"). Field paths are prefixed with `places.` for both search endpoints.

| Preset | Text Search mask | Text SKU | Nearby SKU |
|---|---|---|---|
| `essentials` | `places.id,places.name,nextPageToken` | Text Search Essentials (IDs Only) | **not available**: Nearby has no Essentials tier, so `id` is billed as Pro |
| `pro` | `places.id,places.displayName,places.formattedAddress,places.shortFormattedAddress,places.addressComponents,places.postalAddress,places.location,places.types,places.primaryType,places.primaryTypeDisplayName,places.businessStatus,places.googleMapsUri,places.utcOffsetMinutes,nextPageToken` | Text Search Pro | Nearby Search Pro (drop `nextPageToken`) |
| `enterprise` | `pro` + `places.websiteUri,places.nationalPhoneNumber,places.internationalPhoneNumber,places.rating,places.userRatingCount,places.regularOpeningHours,places.priceLevel` | Text Search Enterprise | Nearby Search Enterprise |

Never request Atmosphere fields. They trigger the most expensive SKU, and we don't store them.

### Field → tier mapping (Text and Nearby Search)

- **Essentials (IDs Only), Text Search only:** `id`, `name`, `attributions`, `consumerAlert`, `movedPlace`, `movedPlaceId`, `nextPageToken`. In Nearby Search, all of these except `nextPageToken` (which Nearby doesn't have) are **Pro**.
- **Essentials (non-ID):** none for the search endpoints. Fields that are Essentials in Place Details (e.g. `location`, `addressComponents`) are billed as **Pro** in search.
- **Pro:** `accessibilityOptions`, `addressComponents`, `addressDescriptor`, `adrFormatAddress`, `businessStatus`, `containingPlaces`, `displayName`, `formattedAddress`, `googleMapsLinks`, `googleMapsTypeLabel`, `googleMapsUri`, `iconBackgroundColor`, `iconMaskBaseUri`, `location`, `openingDate`, `photos`, `plusCode`, `postalAddress`, `primaryType`, `primaryTypeDisplayName`, `pureServiceAreaBusiness`, `shortFormattedAddress`, `subDestinations`, `timeZone`, `types`, `utcOffsetMinutes`, `viewport`. `photos` is Pro in search; the IDs-only label applies only in Place Details.
- **Enterprise:** `currentOpeningHours`, `currentSecondaryOpeningHours`, `internationalPhoneNumber`, `nationalPhoneNumber`, `priceLevel`, `priceRange`, `rating`, `regularOpeningHours`, `regularSecondaryOpeningHours`, `transitStation`, `userRatingCount`, `websiteUri`.
- **Enterprise + Atmosphere:** `reviews`, `reviewSummary`, `editorialSummary`, `generativeSummary`, `neighborhoodSummary`, `routingSummaries`, EV/fuel options, and the amenity/serves* booleans (`takeout`, `delivery`, `dineIn`, `outdoorSeating`, `paymentOptions`, `parkingOptions`, `servesCoffee`, …).

## Pricing (USD, global price list)

**Verify before changing defaults.** The table shows the price per 1,000 billable calls at the first paid tier (from the end of the free cap up to 100,000/month) and the free monthly calls per SKU.

| SKU | Free / month | First tier per 1k | 100k–500k | 500k–1M | 1M–5M | 5M+ |
|---|---|---|---|---|---|---|
| Text Search Essentials (IDs Only) | Unlimited | $0 | – | – | – | – |
| Text Search Pro | 5,000 | $32.00 | $25.60 | $19.20 | $9.60 | $2.40 |
| Text Search Enterprise | 1,000 | $35.00 | $28.00 | $21.00 | $10.50 | $2.63 |
| Text Search Enterprise + Atmosphere | 1,000 | $40.00 | $32.00 | $24.00 | $12.00 | $3.40 |
| Nearby Search Pro | 5,000 | $32.00 | $25.60 | $19.20 | $9.60 | $2.40 |
| Nearby Search Enterprise | 1,000 | $35.00 | $28.00 | $21.00 | $10.50 | $2.63 |
| Nearby Search Enterprise + Atmosphere | 1,000 | $40.00 | $32.00 | $24.00 | $12.00 | $3.40 |
| Place Details Essentials (IDs Only), used for ID refresh | Unlimited | $0 | – | – | – | – |
| Place Details Pro / Enterprise (reference) | 5,000 / 1,000 | $17.00 / $20.00 | | | | |

Free caps follow the tier: Essentials SKUs get 10k, Pro 5k, Enterprise 1k, and IDs Only is unlimited. The pricing page mentions no monthly $ credit; free usage is per-SKU "billable events at no cost".
Cost model for us: one search request is one billable event at the mask's SKU. A 60-result Text Search therefore costs 3 events (see open questions).

## Licensing / caching profile

From the Service Specific Terms §14 (Places API (Legacy and New)):

- §14.1 Places content may be used **without** a Google Map.
- §14.2 It must **not** be used with a non-Google map.
- §14.3 "Customer may temporarily cache **latitude and longitude values** from the Places API for up to **30 consecutive calendar days**, after which Customer must delete the cached latitude and longitude values."

From the Places policies and place ID pages:

- "You must not pre-fetch, cache, or store Places API content beyond the allowed exceptions."
- **Place IDs are exempt** from the caching restrictions and can be stored indefinitely. They can change, though: refresh IDs older than **12 months** with a Place Details request whose mask is only `id` (no charge, IDs Only SKU). A `NOT_FOUND` response means the ID is obsolete.

From the GMP Terms §3.2.3 (applies to all Google Maps Content):

- (a) No scraping. Examples include "copy and save business names, addresses, or user reviews" and "pre-fetch, index, store … outside the services".
- (b) No caching except where the Service Specific Terms allow it.
- (c)(vii) No using Google Maps Content "to improve machine learning and artificial intelligence models, including to train, test, validate or fine-tune the models".
- (c)(iv) No using Places lat/lng as input for point-in-polygon analysis.
- (d)(iii) "use the Google Maps Core Services in a **listings or directory service** or to create or augment an advertising product" is prohibited. Legal should review this against our product (see open questions).

**Our storage profile (provider `licensing`):**

| Data | Storable | Retention |
|---|---|---|
| `id` (place ID) | yes | indefinite. Refresh when older than 12 months. |
| `location.latitude/longitude` | cache only | `retentionDays = 30`, then delete or null out |
| everything else (name, address, phone, website, hours, rating, types, status, URIs) | **no persistent storage** | treat as display-time data. Re-fetch, or keep only for the request/session lifetime. |
| reviews, photos, editorial/generative summaries | never requested, never stored | – |

**Attribution (when we show Places data):**

- Use the Google Maps logo where possible. If space is limited, use the text **"Google Maps"**: no localisation, no capitalisation change, no line wrap.
- Without a Google Map, "you must include the Google logo" (16–19 dp high, with clear space, unmodified).
- If the response has `attributions[]` (provider, providerUri), show those providers next to "Google Maps". "Google Maps" alone is not enough in that case.
- Keep attribution visible, legible, and distinct from non-Google content. Never attribute Google content to another source.
- Photos and reviews need author credit and a `googleMapsUri` link. We don't display them.

## Error handling & rate limits

Errors use the standard Google API `google.rpc.Status` JSON. No Places-specific error page was found; this shape comes from general GMP/Google Cloud docs:

```json
{ "error": { "code": 400, "message": "…", "status": "INVALID_ARGUMENT", "details": [ … ] } }
```

| HTTP | `error.status` | Typical cause | Our handling |
|---|---|---|---|
| 400 | `INVALID_ARGUMENT` | missing/bad field mask, bad language code, changed params with `pageToken`, type conflict | non-retryable, bug/validation |
| 403 | `PERMISSION_DENIED` | bad/restricted key, API not enabled, billing disabled | non-retryable, config error |
| 404 | `NOT_FOUND` | obsolete place ID (Details) | mark ID stale |
| 429 | `RESOURCE_EXHAUSTED` | per-minute quota or self-imposed cap hit | retry with exponential backoff and jitter, then fail the job |
| 5xx | `INTERNAL` / `UNAVAILABLE` | transient | retry with backoff |

Quotas: "The rate limit per minute is per API method per project", so `searchText` and `searchNearby` have separate buckets. Requests that fail authentication don't count. The GMP FAQ lists **Places: 6,000 QPM** with no per-method breakdown. The project's real limits are on the Cloud console Quotas page. Default to a conservative client-side limit (e.g. ≤ 10 RPS) and make it configurable.

## Response field notes

- `id`: place ID string. `name`: `places/{placeId}` (resource name, not the business name).
- `displayName`: `{ text, languageCode }` (LocalizedText). Same for `primaryTypeDisplayName`.
- `formattedAddress`, `shortFormattedAddress`: strings.
- `addressComponents[]`: `{ longText, shortText, types[], languageCode }`.
- `postalAddress`: `{ revision, regionCode, languageCode, postalCode, sortingCode, administrativeArea, locality, sublocality, addressLines[], recipients[], organization }`.
- `location`: `{ latitude, longitude }`.
- `types[]`, `primaryType`: Table A/B type strings. `primaryType` may be missing and is always one of `types`.
- `businessStatus`: `BUSINESS_STATUS_UNSPECIFIED | OPERATIONAL | CLOSED_TEMPORARILY | CLOSED_PERMANENTLY | FUTURE_OPENING`.
- `googleMapsUri`, `websiteUri`, `nationalPhoneNumber`, `internationalPhoneNumber`: strings, absent when unknown.
- `rating`: number 1.0–5.0. `userRatingCount`: integer.
- `regularOpeningHours`: `{ openNow, periods[{ open:{day 0=Sun..6, hour, minute, date?, truncated?}, close:{…} }], weekdayDescriptions[] }`. `close` may be absent for 24h places.
- `priceLevel`: `PRICE_LEVEL_UNSPECIFIED | PRICE_LEVEL_FREE | PRICE_LEVEL_INEXPENSIVE | PRICE_LEVEL_MODERATE | PRICE_LEVEL_EXPENSIVE | PRICE_LEVEL_VERY_EXPENSIVE`.
- `utcOffsetMinutes`: integer.
- `attributions[]`: `{ provider, providerUri }`.
- Any unrequested or unknown field is simply absent. Parse defensively, since every field is optional.

Place types: only **Table A** values are valid in `includedType` (Text) and `included/excluded(Primary)Types` (Nearby). Table B values appear only in responses. Table A has 19 categories, including Automotive, Business, Food and Drink, Health and Wellness, Services, and Shopping. Examples: `restaurant`, `cafe`, `plumber`, `electrician`, `dentist`, `hair_salon`, `car_repair`, `lawyer`, `accounting`, `real_estate_agency`, `gym`. More types were added on 2026-02-12 (e.g. `coworking_space`, `marketing_consultant`, `medical_clinic`). The types page was last updated 2026-10-13.

## Open questions / uncertain

1. **Per-page billing:** no doc page says explicitly that each `pageToken` request is a separate billable event. We assume it is (each page is its own `searchText` call).
2. **`nextPageToken` in the mask:** no doc says it is mandatory, but it is a response field and only fields in the mask are returned, so always include it when paginating. It is listed as an IDs-Only field, so it adds no cost.
3. **Default per-method QPM:** only the FAQ's "Places 6,000 QPM" was found. Check the Cloud console.
4. **Error format:** no Places (New) error reference page exists. The shape and status mapping come from general Google API conventions and other GMP API docs (e.g. Roads).
5. **Regional pricing:** the figures above are the global list. Some regions (e.g. India) and the EEA (separate ToS since 2025-07-08) may differ.
6. **Directory/listings restriction (ToS §3.2.3(d)(iii))** may affect a "business finder" product. Get a product/legal decision before using Google as a persisted lead source. Until then, only the place ID and lat/lng (30 days) are persisted.
7. The Nearby Search section of the types page says Table B "populates" the type filters, which contradicts the Table A-only rule. We send Table A only.

## How the provider uses this (BF-018)

- **Queries.** Category-only circle tiles → one Nearby Search per category (all its Google types, ≤ 50,
  `rankPreference=DISTANCE`, 20 results; a full answer marks the tile *saturated* so the planner splits it).
  Box tiles, keywords, or circles with keywords → Text Search per Google type (`includedType` +
  `strictTypeFiltering`), `locationRestriction.rectangle` (a circle's enclosing rectangle), `pageSize` 20, pages
  via `pageToken`; saturated when the third full page has no further token.
- **Tiers.** Workspace setting `discovery.googleFieldTier` (default `pro`). `essentials` (IDs only) cannot produce
  records (no names), so discovery serves it as `pro`; the IDs-only mask is used for the free connection test.
- **Storage.** Records carry `expiresAt = fetchedAt + 30 days`; the stored raw payload is only `{ id }`. The
  retention job (ADR-0013) removes expired Google content and keeps fields another source confirms.
- **Cost.** Each call is metered in `provider_usage` with its SKU; cost counts the billing account's free monthly
  calls first (`DISCOVERY_APPLY_FREE_TIER`), per account: the workspace's own key or the shared deployment key.
- **Limits.** `GOOGLE_PLACES_REQUESTS_PER_SECOND` (default 5) per key, token bucket in Valkey; retries on 429/5xx
  honour `Retry-After` (≤ 30 s), 4xx are not retried; breaker per provider.
- **Tests.** Fixtures in `__fixtures__/` are synthetic responses in the documented shape (fictional businesses,
  no key, no personal data); no live calls in tests or CI.
