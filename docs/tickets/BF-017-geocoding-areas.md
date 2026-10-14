---
id: BF-017
title: Geocoding, geographic areas (incl. Saint-Barthélemy pack) and area tiling
milestone: M1 Find & List
epic: business-graph
type: feature
priority: P0
size: M
depends_on: [BF-011, BF-014]
blocks: [BF-018, BF-021, BF-049]
areas: [api, db]
---

# BF-017 — Geocoding, geographic areas (incl. Saint-Barthélemy pack) and area tiling

## Context
Users scope searches with free text: an island ("St Barth"), a town or quarter ("Gustavia", "Saint-Jean"), a Dutch postcode ("1012 AB" / PC4 "1012"), a US ZIP ("33139"), or "within 3 km of Lorient". Discovery needs an area geometry it can **tile** into provider-sized queries (BF-020), and listing search filters by area (BF-022). Geography types and indexes exist (BF-003, BF-014).

## Goal
A `LocationResolver` that turns free text into one or more candidate areas (polygon or point+radius) with confidence, backed by an imported `geo_areas` table (with a curated Saint-Barthélemy pack and optional NL PC4 / US ZCTA packs) and external geocoders with caching; plus tiling utilities for discovery.

## Scope
**In scope**
- Tables:
  - `geo_areas`: `id`, `kind` (`country|admin1|admin2|locality|district|postal_code|island|custom`), `country_code`, `code` (postal/ZIP/admin code), `name` jsonb `{en, fr, local?}`, `aliases` text[] (incl. unaccented variants and common spellings: "St Barth", "St Barts", "Saint Barth", "SBH"), `parent_id`, `geom` geography(MultiPolygon), `centroid` geography(Point), `approximate` bool, `source` (`osm|overture|census|pdok|custom`), `source_ref`, `area_km2`, timestamps; GiST on `geom`, trigram GIN on a generated unaccented names+aliases column.
  - `geocode_cache`: `query_normalized`, `provider`, `country_hint`, `result` jsonb, `created_at`, `expires_at`; unique (`query_normalized`, `provider`, `country_hint`).
- Import packs (idempotent CLI `pnpm geo:import --pack <name>`), each documenting source + license:
  - `bl` — Saint-Barthélemy: island boundary (country BL) and localities/quarters (Gustavia, Saint-Jean, Lorient, Flamands, Colombier, Corossol, Public, Marigot, Grand Cul-de-Sac, Petit Cul-de-Sac, Toiny, Saline, Gouverneur, Vitet, Pointe Milou, Anse des Cayes, Lurin, Camaruche, Merlette, Devet, Grand Fond, Mont Jean, …) from OpenStreetMap (Overpass extract) or Overture divisions; where only points exist, create approximate polygons (Voronoi within island boundary preferred over circles) flagged `approximate=true`.
  - `mf` — Saint-Martin (French side) basic localities (optional, same method).
  - `nl-pc4` — Dutch 4-digit postcode areas (CBS/PDOK open data).
  - `us-zcta` — US ZIP Code Tabulation Areas (Census TIGER), filterable by state (`--state FL`).
- `Geocoder` port with adapters: `NominatimGeocoder` (default; respects usage policy: ≤ 1 req/s via Valkey rate limiter, custom User-Agent with contact from config, `polygon_geojson=1` where useful; base URL configurable to a self-hosted instance), `GoogleGeocoder` (optional, key from secrets vault). Cached via `geocode_cache` (TTL 90 days).
- `LocationResolver.resolve(text, { locale, countryHint?, near? })`:
  1. Pattern parsers: NL postcode (`^\d{4}\s?[A-Z]{2}$` → PC4 area), US ZIP (`^\d{5}(-\d{4})?$`), "within N km/mi of X" / "dans un rayon de N km autour de X", lat/lng literals.
  2. Local lookup in `geo_areas` (names/aliases, accent-insensitive, country-biased ranking, kind preference: locality > island > admin).
  3. External geocoder fallback; results optionally persisted as `custom` areas when polygons are returned.
  4. Output `LocationResolution { candidates: [{ areaId?, kind, label, geometry: MultiPolygon | { center, radiusM }, bbox, confidence, source }], chosen?: index }`; ambiguity (e.g. "Saint-Jean" exists in many countries) handled by country hint (workspace default country, e.g. BL) and returned as multiple candidates.
- Tiling utilities (`geo/domain/tiling.ts`): `tileAsBBoxes(geometry, cellKm)` clipped to geometry; `tileAsCircles(geometry, radiusM)` (hex-packed centers covering the polygon); `subdivide(tile)` (quadtree split used by adaptive discovery); utilities tested with BL and an urban PC4.
- APIs: `GET /v1/geo/resolve?q=&locale=` (permission `business:read`), `GET /v1/geo/areas/:id` (GeoJSON), `GET /v1/geo/areas?kind=&country=&q=` (typeahead), `POST /v1/geo/areas` (custom polygon from the map draw tool, `business:write`).
- Workspace default country/region hint from `org_settings` (add field `default_country_code`; BL for the primary workspace).

**Out of scope**
- Map UI (→ BF-023). Discovery planning (→ BF-020 uses tiling).

## Requirements
### Functional
- "St Barth", "Saint-Barthélemy", "SBH", "St Barts" resolve to the BL island area; "Gustavia" to its locality; "1012" (NL) to PC4 1012 when the NL pack is imported; "33139" to the ZCTA.
- Nominatim usage stays within policy (rate limit + caching + User-Agent).
### Non-functional
- Local resolution p95 < 30 ms; external geocoding cached.
- Licensing: OSM (ODbL) attribution recorded in an attributions page (BF-061 renders it); packs record source/license.

## Design
- Patterns: Strategy (`Geocoder` adapters), Chain (pattern → local → external), Value Object (`Area`, `LocationResolution`).
- Use PostGIS for clipping (`ST_Intersection`) when generating tiles server-side, or Turf.js in TS for pure functions — choose and document; tests must run without network.

## Implementation plan
1. Tables + migration; area repository with geo queries.
2. BL pack import (Overpass query + Voronoi approximations) — commit a small cached extract for tests (license-compliant attribution).
3. Optional packs (NL PC4, US ZCTA) with streaming import for large files.
4. Geocoder adapters + cache + rate limiter.
5. Resolver chain + pattern parsers (unit tests EN/FR phrasing).
6. Tiling utilities with tests; APIs.

## Testing
- Unit: pattern parsers ("within 5 km of Lorient", "dans un rayon de 2 km autour de Gustavia", "1012 AB", "33139"), alias normalization, ambiguity ranking with country hint, tiling coverage (union of tiles covers polygon; no tile outside bbox), quadtree subdivision.
- Integration: BL pack import idempotent; resolve queries against imported data; Nominatim adapter with MSW fixtures and rate limiting; cache hits.

## Acceptance criteria
- [ ] `geo_areas` populated by the BL pack (island + localities, approximate flags where needed); NL/US packs importable on demand.
- [ ] `LocationResolver` returns candidates with confidence for all example inputs (tests).
- [ ] Nominatim adapter rate-limited and cached; Google adapter optional via secret.
- [ ] Tiling utilities (bbox, circles, quadtree) tested.
- [ ] Geo APIs available with permissions.

## Agent prompt
```text
Implement BF-017 (Geocoding, geographic areas and area tiling).

Read first: AGENTS.md, docs/ARCHITECTURE.md §6.2 (geography conventions), docs/adr/0013, docs/DOMAIN.md (Area).
Reuse: @bf/db geography types (BF-003), business graph (BF-014), secrets resolver (BF-011) for Google.

Rules:
- Respect the Nominatim and Overpass usage policies (rate limits, User-Agent, caching); tests use recorded fixtures.
- Saint-Barthélemy is the primary market: make the BL pack excellent (quarters, aliases, FR/EN names).
- Keep lat/lng order explicit; test geometry round-trips.
- Record data sources and licenses in each pack's README.

Verify: pnpm verify && pnpm test:int; pnpm geo:import --pack bl twice (idempotent); show resolve outputs for
the example inputs in the PR.
```

## References
- docs/ARCHITECTURE.md §6.2 · ADR-0013
- Nominatim usage policy: https://operations.osmfoundation.org/policies/nominatim/ · Overpass API: https://wiki.openstreetmap.org/wiki/Overpass_API · Census ZCTA: https://www.census.gov/programs-surveys/geography/guidance/geo-areas/zctas.html · PDOK: https://www.pdok.nl/
