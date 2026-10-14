---
id: BF-019
title: Open-data and scraper providers (Overture, Foursquare OS Places, OSM, Maps scraper)
milestone: M1 Find & List
epic: discovery
type: feature
priority: P1
size: L
depends_on: [BF-008, BF-018]
blocks: []
areas: [intel, api, worker]
---

# BF-019 — Open-data and scraper providers (Overture, Foursquare OS Places, OSM, Maps scraper)

## Context
Open datasets are free, storable long-term and improve coverage: **Overture Maps Places** (GeoParquet on S3/Azure, monthly releases, fields incl. websites, socials, emails, phones, confidence; the `categories` property is replaced by `basic_category` + `taxonomy` from the September 2026 release), **Foursquare OS Places** (100M+ POIs, Apache-2.0, monthly, now gated on Hugging Face), and **OpenStreetMap** (Overpass, ODbL). A self-hosted **Google Maps scraper** (`gosom/google-maps-scraper`, MIT) exists but scraping may violate Google's terms — it stays behind a feature flag, admin-only, off by default ([ADR-0013](../adr/0013-discovery-providers-and-data-licensing.md)). Data-heavy queries run in the Python intel service (DuckDB) ([ADR-0002](../adr/0002-typescript-first-with-python-sidecar.md)).

## Goal
Four additional providers behind the BF-018 framework: Overture and Foursquare via intel's DuckDB endpoint (with regional caching), OSM via Overpass, and the flagged Maps scraper via its REST API — all normalized to `SourceRecord`, with licensing profiles and tests.

## Scope
**In scope**
- **Intel service** (`services/intel`):
  - `POST /v1/open-data/places/search` — request: `{ dataset: 'overture'|'foursquare', release?: string, geometry: bbox|polygon, categories: string[] (dataset-native), limit, cursor? }`; response: normalized records (contract generated from `@bf/contracts`), `release`, `nextCursor`.
  - DuckDB with `httpfs` + `spatial` extensions; Overture: read `release/<release>/theme=places/type=place/*` with predicate pushdown on the `bbox` struct columns, then `ST_Intersects` for polygons; select fields (`id` (GERS), `names.primary`, `basic_category`, `taxonomy`, `confidence`, `websites`, `socials`, `emails`, `phones`, `addresses`, `operating_status`, `geometry`). Release discovery: latest release from the Overture release catalog/STAC (verify) or config `OVERTURE_RELEASE`.
  - Foursquare OS Places: read parquet via `hf://` paths (requires `HF_TOKEN` with accepted dataset conditions — verify current access method) filtering by lat/lng bbox and `fsq_category_ids`; exclude `date_closed` not null.
  - Regional cache: materialize extracts per (dataset, release, bbox rounded) to object storage (`bf-artifacts/open-data/...parquet`) and local disk; subsequent queries for the area hit the cache. TTL until next release.
  - CPU/IO bounded (timeouts, memory limits via DuckDB settings); tests with tiny local parquet fixtures (no network).
- **TypeScript providers** (`modules/discovery/infrastructure/providers/`):
  - `OvertureProvider`, `FoursquareProvider`: call intel via `IntelClient` (signed requests — implement the shared `IntelClient` adapter here if BF-026 has not yet: base URL, HMAC signer from BF-008, timeouts, retries, circuit breaker); mapping to `SourceRecord`; licensing: storable, attribution required (CDLA-Permissive / Apache-2.0 / ODbL components as applicable — record per-source license from the Overture `sources` field when available).
  - `OsmOverpassProvider`: Overpass QL for bbox + tag sets from OSM category mappings (BF-015), `out center tags;` for ways/relations, mapping tags (`name`, `website`/`contact:website`, `phone`/`contact:phone`, `email`/`contact:email`, `opening_hours` (parse to structured hours where possible), `addr:*`); usage policy compliance (rate limit, User-Agent, configurable endpoint for a self-hosted instance); ODbL attribution.
  - `MapsScraperProvider` (gosom): only when env `FEATURE_MAPS_SCRAPER=true` **and** org flag `mapsScraper` **and** an owner has acknowledged the ToS warning (stored in audit log with timestamp); uses the scraper REST API (create job with keywords per category × area, language, `geo`/`zoom`/`radius` or grid bbox mode, depth, optional email extraction; poll; download JSON) — verify the current API; mapping to `SourceRecord` with provider `gmaps_scraper`; licensing profile: short retention, no reviews stored, attribution N/A, clear warning text.
- Settings UI additions (`/settings/integrations` → "Discovery sources"): enable/disable providers per workspace, preference order (drag), Overture release (auto/pinned), HF token secret, scraper acknowledgement dialog with warning.

**Out of scope**
- Run orchestration and planning (→ BF-020). Photos/reviews from these sources (not used).

## Requirements
### Functional
- Overture query for the BL bbox with categories (e.g. `cafe`, `hair_salon`) returns normalized records with websites/phones when present.
- Scraper provider cannot run unless all three gates are satisfied (tests).
### Non-functional
- First Overture query for a new small area < 60 s; cached repeat < 3 s (document measurements).
- No network in unit/integration tests (fixtures: tiny parquet files, recorded Overpass JSON, recorded scraper JSON).

## Design
- Intel: `app/routers/open_data.py`, `app/services/open_data/{overture.py, foursquare.py, cache.py, mapping.py}`; DuckDB connection per request with an in-process pool; parameterized queries only.
- TS: providers implement the BF-018 port; mapping functions pure and unit-tested.

## Implementation plan
1. Verify Overture release paths, schema (basic_category/taxonomy), STAC/catalog; Foursquare HF access method and schema; Overpass usage policy; gosom REST API.
2. Intel endpoint + DuckDB queries + cache + tests with parquet fixtures.
3. `IntelClient` adapter (if not present) + Overture/Foursquare providers + mapping tests.
4. OSM provider + opening_hours parsing (library) + tests.
5. Scraper provider with gating + tests.
6. Settings UI for sources/preferences/acknowledgement.

## Testing
- Python: queries against fixture parquet (bbox + polygon filters, category filters, cursoring), cache hit/miss, error handling (timeouts) — `uv run task verify`.
- TS: mapping snapshots per provider; gating truth table for scraper; IntelClient signing + retry with MSW.
- Integration: provider selection includes/excludes these providers per settings.

## Acceptance criteria
- [ ] Overture and Foursquare providers return normalized records through intel with regional caching.
- [ ] OSM Overpass provider with tag mappings and opening hours parsing.
- [ ] Maps scraper provider gated by env flag + org flag + recorded owner acknowledgement; off by default.
- [ ] Licensing/attribution recorded per source; settings UI for enabling and ordering providers.
- [ ] Python and TS test suites pass without network.

## Agent prompt
```text
Implement BF-019 (Open-data and scraper providers).

Read first: AGENTS.md, docs/adr/0002 and 0013, docs/ARCHITECTURE.md §3 (intel), docs/conventions/security.md §4.
Reuse: provider framework (BF-018), intel skeleton + signing + safe fetch (BF-008), category mappings (BF-015).

Rules:
- Verify current Overture paths/schema (basic_category + taxonomy; categories removed Sept 2026), Foursquare OS
  Places access via Hugging Face, Overpass usage policy and the gosom scraper REST API before coding.
- The scraper is legally sensitive: implement the three gates and the visible warning exactly; default off.
- DuckDB queries must be parameterized; never interpolate user input into SQL.

Verify: pnpm verify && pnpm test:int && (cd services/intel && uv run task verify). Optionally run a real
Overture query for the BL bbox locally and report timing/count.
```

## References
- ADR-0002 · ADR-0013
- Overture places guide: https://docs.overturemaps.org/guides/places/ · Overture release notes: https://docs.overturemaps.org/blog/ · Foursquare OS Places: https://opensource.foursquare.com/os-places/ · DuckDB spatial: https://duckdb.org/docs/extensions/spatial/overview · Overpass: https://wiki.openstreetmap.org/wiki/Overpass_API · gosom scraper: https://github.com/gosom/google-maps-scraper
