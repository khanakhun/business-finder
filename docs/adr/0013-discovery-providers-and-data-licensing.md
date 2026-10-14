# ADR-0013: Discovery providers, data licensing and retention

- Status: Accepted
- Date: 2026-10-14
- Tickets: BF-018, BF-019, BF-020, BF-060

## Context

Business data comes from sources with very different terms: official paid APIs with caching restrictions (Google Places), openly licensed datasets (Overture Maps Places, Foursquare OS Places — Apache-2.0/CDLA-permissive families), community data (OpenStreetMap, ODbL), the business's own website, and scrapers whose use may violate a platform's terms. Coverage on small islands like Saint-Barthélemy may be uneven, so combining sources matters.

## Decision

- Providers implement `DiscoveryProvider` with declared **capabilities** (categories, geo query types, max results per call, pagination), **cost model** (per call / per result / free), **rate limits** and **licensing profile**: `{ attributionRequired, retentionDays | null, storableFields[], commercialUseAllowed, notes }`.
- **Preference order** (configurable per workspace): open data (Overture, Foursquare) → official API (Google Places) → feature-flagged scraper (off by default, admin-only, with a visible ToS warning).
- **Retention enforcement**: each `business_sources` row has `expires_at` from the provider's licensing profile. The retention job deletes expired source payloads and recomputes golden-record fields whose only provenance expired (fields confirmed by another source — website, open data, manual — survive). Identifiers explicitly allowed to be stored indefinitely (e.g. Google `place_id`) are kept.
- **Attribution**: provider attribution displayed where required (e.g. Google content in the UI shows Google attribution; open-data licenses listed on an attributions page).
- **Photos/reviews**: provider photos and reviews are displayed via provider-compliant mechanisms and are **not** reused in generated sites unless the license allows it; generated sites use the business's own website assets (with an ownership caveat for private previews), stock photos with attribution, or AI-generated images (BF-038).
- Costs and quotas are metered per provider per workspace (`provider_usage`) with budgets per discovery run.

## Alternatives considered

| Option | Why not |
|---|---|
| Scraper-first | Cheapest per record but legally risky and brittle; kept only as an opt-in provider. |
| Google-only | Best coverage but cost and strict caching rules; combining with open data lowers cost and improves durability of stored facts. |

## Consequences

- Positive: data we keep long-term is data we are allowed to keep; costs are visible and bounded.
- Negative: golden records can lose fields after TTL if no other source confirms them — the enrichment pipeline re-confirms facts from the business's website, which we can store.
- Action: the exact Google Maps Platform terms must be re-read at implementation time (BF-018) and encoded in the provider's licensing profile.

## References

- Google Maps Platform Terms & Places API policies: https://cloud.google.com/maps-platform/terms , https://developers.google.com/maps/documentation/places/web-service/policies
- Overture Maps Places: https://docs.overturemaps.org/guides/places/
- Foursquare OS Places: https://opensource.foursquare.com/os-places/
