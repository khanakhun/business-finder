# Open data sources: verified facts

Checked: 2026-10-15

Legend: **[verified]** = checked against an official doc/repo or by a live request on the check date.
**[observed]** = seen in a live request/sample, not stated as a guarantee in docs.
**[unconfirmed]** = not verified; do not rely on without re-checking.

## Sources consulted

- Overture STAC root: https://stac.overturemaps.org/catalog.json (live JSON)
- Overture places collection: https://stac.overturemaps.org/2026-09-23.1/places/place/collection.json
- Overture docs: https://docs.overturemaps.org/schema/reference/places/place/ ,
  https://docs.overturemaps.org/attribution/ , https://docs.overturemaps.org/release-calendar/ ,
  https://docs.overturemaps.org/release-calendar.json , https://docs.overturemaps.org/getting-data/duckdb/
- Overture schema repo: https://github.com/OvertureMaps/schema (release `overture-schema-theme-places-v2.0.0`,
  `packages/overture-schema-theme-places/src/overture/schema/places/place.py`)
- Live parquet footers read with DuckDB 1.5.6 (`DESCRIBE`) from `s3://overturemaps-us-west-2/...` (anonymous)
- Foursquare HF dataset: https://huggingface.co/datasets/foursquare/fsq-os-places (card + `/api/datasets/...`)
- Foursquare schema: https://docs.foursquare.com/data-products/docs/places-os-data-schema
- DuckDB HF docs: https://duckdb.org/docs/current/core_extensions/httpfs/hugging_face.html
- Overpass: https://wiki.openstreetmap.org/wiki/Overpass_API ,
  https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL ,
  https://dev.overpass-api.de/overpass-doc/en/preface/commons.html
- OSM licence: https://www.openstreetmap.org/copyright , https://osmfoundation.org/wiki/Licence/Attribution_Guidelines
- opening_hours: https://registry.npmjs.org/opening_hours , https://github.com/opening-hours/opening_hours.js ,
  https://pypi.org/pypi/opening-hours-py/json
- gosom: https://github.com/gosom/google-maps-scraper (README, `web/web.go`, `web/job.go`,
  `runner/runner.go`, `runner/webrunner/webrunner.go`, `gmaps/entry.go`, `api/docs/swagger.yaml`),
  Docker Hub tags API for `gosom/google-maps-scraper`

---

## 1. Overture Maps — Places

### Releases and discovery

| Item | Fact | Status |
|---|---|---|
| Naming | `yyyy-mm-dd.x`; `x` = patch/hotfix of that release (e.g. `2026-09-23.0`, `2026-09-23.1`) | verified (release calendar) |
| Latest release | `2026-09-23.1` (published 2026-09-25), schema `v2.0.0` | verified (STAC root `"latest"`) |
| Discover latest | `GET https://stac.overturemaps.org/catalog.json` → top-level key `"latest"` (string), and the child link with `"latest": true` | verified |
| Per-release catalog | `https://stac.overturemaps.org/<release>/catalog.json` has `release:version`, `schema:version` | verified |
| Places collection | `https://stac.overturemaps.org/<release>/places/place/collection.json` → `partition:glob`, `table:columns`, `table:row_count` (81,455,423 in 2026-09-23.1), 16 files | verified |
| Release schedule JSON | `https://docs.overturemaps.org/release-calendar.json` (`releases[].date/dataVersion/schemaVersion`) | verified |
| Next planned | `2026-10-21.0`, `2026-11-18.0`, `2026-12-16.0` ("reserved for quarterly major breaking change") — proposed, may change | verified (calendar) |
| Cadence | Monthly; major (breaking) schema changes at most quarterly (Mar/Jun/Sep/Dec) | verified |
| Retention | Releases kept public for max **60 days (two monthly releases)**, then deleted by lifecycle policy → never hard-code a release; resolve via STAC | verified |
| PMTiles | `https://tiles.overturemaps.org/<release>/places.pmtiles` | verified (STAC link) |

### Storage paths and access

| Item | Value | Status |
|---|---|---|
| S3 glob | `s3://overturemaps-us-west-2/release/<release>/theme=places/type=place/*` | verified |
| S3 HTTPS | `https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/<release>/theme=places/type=place/<file>.parquet` | verified (STAC asset) |
| File names | `part-000NN-<uuid>-c000.zstd.parquet` (zstd GeoParquet 1.1.0), ~680 MB each | verified |
| Region / auth | `us-west-2`, `requester_pays: false`; anonymous read works with only `SET s3_region='us-west-2'` (no credentials) | verified (live DuckDB read) |
| Azure | account `overturemapswestus2`, container `release`: `https://overturemapswestus2.blob.core.windows.net/release/<release>/theme=places/type=place/<file>.parquet` | verified (STAC asset) |
| Azure via DuckDB `azure` ext | `az://` URL form + anonymous config | unconfirmed (docs only mention `INSTALL azure;`) |
| Per-file STAC items | `.../places/place/000NN/000NN.json` with spatial bbox per file + `aws`/`azure` asset hrefs → can pick only files overlapping an AOI | verified |

DuckDB pattern from Overture docs (verified): `LOAD spatial; LOAD httpfs; SET s3_region='us-west-2';`
then `read_parquet('s3://.../theme=places/type=place/*', filename=true, hive_partitioning=1)` with
`WHERE bbox.xmin BETWEEN <w> AND <e> AND bbox.ymin BETWEEN <s> AND <n>` ("Only use the bbox min values
because they are point geometries").

### Places schema (release 2026-09-23.1, schema v2.0.0) — read from parquet footer

| Column | DuckDB type | Notes | Status |
|---|---|---|---|
| `id` | VARCHAR | Feature ID; GERS ID when the feature is part of GERS | verified |
| `geometry` | GEOMETRY('OGC:CRS84') (WKB, Point) | GeoParquet `encoding: WKB`, `geometry_types: ["Point"]` | verified |
| `bbox` | STRUCT(xmin, xmax, ymin, ymax DOUBLE) | Declared as GeoParquet `covering.bbox` → row-group pushdown | verified |
| `confidence` | DOUBLE | 0..1; set to 0 when `operating_status = 'permanently_closed'` | verified (docs) |
| `names` | STRUCT(primary VARCHAR, common MAP(VARCHAR,VARCHAR), rules STRUCT(...)[]) | use `names.primary` | verified |
| `basic_category` | VARCHAR | snake_case "basic level" category (e.g. `hotel`) | verified |
| `taxonomy` | STRUCT(primary VARCHAR, hierarchy VARCHAR[], alternates VARCHAR[]) | `primary` == last item of `hierarchy`; `hierarchy` general→specific, min 1, unique; `alternates` optional unordered, not part of hierarchy | verified (schema repo) |
| `websites` / `socials` / `emails` / `phones` | VARCHAR[] | lists, min length 1, unique items when present | verified |
| `brand` | STRUCT(wikidata VARCHAR, names STRUCT(primary, common, rules)) | | verified |
| `addresses` | STRUCT(freeform, locality, postcode, region, country VARCHAR)[] | list | verified |
| `operating_status` | VARCHAR | enum `open`, `permanently_closed`, `temporarily_closed`; nullable. Not opening hours | verified (schema enum) |
| `sources` | STRUCT(property, dataset, license, record_id, update_time VARCHAR, confidence DOUBLE, between DOUBLE[], provider, resource, version VARCHAR)[] | `dataset` optional since v2.0.0 | verified |
| `version` | INTEGER | feature version | verified |
| `theme`, `type` | VARCHAR | hive partition columns (`places`, `place`) | verified |

Schema change: **`categories` (STRUCT(primary VARCHAR, alternate VARCHAR[])) was removed** in schema
v2.0.0 (places package changelog 2026-09-02: "Removed the deprecated `categories` field from `place` and
standardized place categorization on `taxonomy`"). Verified by footer diff: present in data release
`2026-08-19.0` (schema v1.18.0, alongside `basic_category` + `taxonomy`), absent from `2026-09-23.0`
onward. Code must use `taxonomy.primary` / `basic_category`.

Observed value distribution (one file, `part-00000`, 5.12 M rows, 2026-09-23.1): `operating_status`
NULL 4,206,721 / `open` 862,704 / `permanently_closed` 51,249 (no `temporarily_closed` in that file).

### Licences and attribution (places)

Places has **no single theme licence**; licence is per source (`sources[].license`).

| `sources[].dataset` (observed) | `sources[].license` (observed) | Required attribution (Overture attribution page) |
|---|---|---|
| `meta` | CDLA-Permissive-2.0 | "Data from Meta. Available under CDLA Permissive 2.0." |
| `Microsoft`, `PinMeTo`, `RenderSEO`, `DAC`, `BrightQuery` (also Krick per docs) | CDLA-Permissive-2.0 | "Data from [Name]. Available under CDLA Permissive 2.0." |
| `Foursquare` | Apache-2.0 | "Copyright 2024 Foursquare Labs, Inc. All rights reserved." + note that data was transformed to the Overture schema; NOTICE.txt linked |
| `AllThePlaces` | CC0-1.0 | "Data from AllThePlaces. Available under CC0 1.0." |
| `Overture`, `Overture-signals` | CDLA-Permissive-2.0 | not listed separately on attribution page — unconfirmed |

Optional citation suggested by Overture: `Overture Maps Foundation, overturemaps.org` (+ access date).
The `© OpenStreetMap contributors` line is required for ODbL themes (base, buildings, divisions,
transportation), not listed for places. No ODbL source was observed in places sources (one-file sample).

---

## 2. Foursquare OS Places

| Item | Fact | Status |
|---|---|---|
| Access | Hugging Face dataset `foursquare/fsq-os-places`, **gated** (`gated: "auto"` = auto-approval after submitting form: Organization, Title, Country, use = Research/Education/Commercial, agree checkbox) | verified |
| Unauthenticated download | HTTP 401 on `resolve/main/...parquet` | verified |
| Latest release | `dt=2026-09-15` (monthly-ish `dt=YYYY-MM-DD` dirs back to `2024-12-03`) | verified |
| Layout | `release/dt=<date>/places/parquet/places_000000..000099.parquet` (100 files); `release/dt=<date>/categories/parquet/categories_000000.parquet`; `release/dt=<date>/deltas/parquet/deltas_0000NN.parquet` (since `2025-09-09`) | verified |
| Discover latest | Dataset card YAML `configs[].data_files` points at the latest `dt=`; or list `siblings` from `https://huggingface.co/api/datasets/foursquare/fsq-os-places` | verified |
| DuckDB path | `hf://datasets/foursquare/fsq-os-places/release/dt=2026-09-15/places/parquet/*.parquet` (glob supported; `@<revision>` optional) | verified (DuckDB doc + card path) |
| DuckDB auth | `CREATE SECRET hf_token (TYPE huggingface, TOKEN '<hf_token>');` or `(TYPE huggingface, PROVIDER credential_chain)` (reads `~/.cache/huggingface/token`). Token's user must have accepted the gate | verified (doc); gate+token interplay unconfirmed by live test |
| Licence | Apache-2.0 (card `license: apache-2.0`) | verified |
| Attribution | Apache-2.0 notice "Copyright 2024 Foursquare Labs, Inc." (schema page); keep licence/NOTICE | verified (text); exact NOTICE file for HF not checked |

### Places schema (from Foursquare docs; parquet footer NOT read — gated)

| Column | Doc type | Notes |
|---|---|---|
| `fsq_place_id` | String | formerly `fsq_id`/venueid |
| `name` | String | |
| `latitude`, `longitude` | Decimal | WGS84 |
| `address`, `locality`, `region`, `postcode`, `admin_region`, `post_town`, `po_box` | String | `region` abbreviated for US/CA/AU/BR |
| `country` | String | ISO 3166-1 alpha-2 |
| `date_created`, `date_refreshed`, `date_closed` | Date (doc) | physical parquet type unconfirmed (may be string) |
| `tel`, `website`, `email` | String | single values (not lists) |
| `facebook_id`, `instagram`, `twitter` | String | handles/ids, not URLs |
| `fsq_category_ids`, `fsq_category_labels` | Array(String) | most granular categories; labels are `>`-breadcrumbs |
| `placemaker_url` | String | |
| `unresolved_flags` | Array(String) | `closed`, `duplicate`, `delete`, `privatevenue`, `inappropriate`, `doesnt_exist` |
| `geom` | WKB | |
| `bbox` | struct(xmin, ymin, xmax, ymax double) | usable for pushdown like Overture |

Categories table: `category_id`, `category_level` (1–6), `category_name`, `category_label`,
`level1_category_id/name` … `level6_category_id/name`. Card's recommended "open & active" filter:
`date_closed IS NULL AND date_refreshed >= current_date - 365`. Card also lists non-commercial category
IDs to exclude (City, Road, Neighborhood, Event, …). Deltas schema: unconfirmed.

---

## 3. Overpass API (OSM)

| Item | Fact | Status |
|---|---|---|
| Main endpoint | `https://overpass-api.de/api/interpreter` (FOSSGIS) | verified |
| Daily guidance | < 10,000 queries/day and < 1 GB/day, ≤ 10 min total processing; **divide by 100 for regular/automated use** | verified (wiki) |
| Concurrency | "No parallel running of multiple scripts"; slots per user (IP); count shown on line 3 of `/api/status` ("Rate limit: N") | verified; slot number not documented (often 2 — unconfirmed) |
| Commercial use | "Commercial use should use self-hosted or paid Overpass servers" | verified |
| Identification | Send `User-Agent` or `Referer` that uniquely identifies the app | verified |
| 429 | Rate-limit rejection; wiki: on 429/406 pause 30 s before next request | verified |
| 504 | Rejected for resource mismatch (timeout/maxsize vs load) | verified |
| Status | `GET /api/status` → user id (line 1), `Rate limit:` (line 3), running queries / slot availability | verified (doc); live: main instance returned capacity page |
| Live 2026-10-15 | `overpass-api.de` `/api/interpreter` returned **HTTP 502** "server is currently at capacity… retry with exponential backoff… for automated use run a local instance"; `/api/status` timed out. `maps.mail.ru` instance answered (Overpass 0.7.62.4) | observed |
| Other public instances | `maps.mail.ru/osm/tools/overpass/api/interpreter` ("no requests limitations"), `overpass.private.coffee` ("no rate limit"; returned 500 on test), paid: Geofabrik, Tracestrack, NextGIS, etc. | verified list; reliability observed poor |

Query syntax (verified, Overpass QL wiki): settings `[out:json][timeout:<s>][maxsize:<bytes>]` — timeout
default 180 s, maxsize default 536870912 (512 MiB). Bbox filter order is **(south,west,north,east)**
(lat/lon); global `[bbox:s,w,n,e]` also allowed. `nwr` = nodes+ways+relations. `out center tags;` →
`center` adds centre point for ways/relations; nodes kept `lat`/`lon` in live test (observed).
Limit with `out center tags 100;`. Example (live-tested):

```
[out:json][timeout:25];
nwr["shop"="bakery"](48.85,2.34,48.86,2.35);
out center tags;
```

Response `osm3s.copyright`: "The data included in this document is from www.openstreetmap.org. The data
is made available under ODbL." (observed).

Attribution (verified, OSMF guideline): credit "OpenStreetMap" linked to
https://www.openstreetmap.org/copyright (accepted forms: "© OpenStreetMap contributors",
"© OpenStreetMap"). Licence ODbL 1.0; share-alike for derivative databases; stored DB extracts must carry
attribution plus ODbL text/link (readme/metadata).

---

## 4. opening_hours parsing

| Item | Fact | Status |
|---|---|---|
| npm package | `opening_hours` latest **3.15.0** (published 2026-09-21) | verified (npm registry) |
| Licence | **LGPL-3.0-only** (not MIT) | verified |
| Repo | https://github.com/opening-hours/opening_hours.js ; TS types `./types/index.d.ts`; ESM `build/opening_hours.esm.mjs` | verified |
| Constructor | `new opening_hours(value, nominatim_object|null, optional_conf)`; pass `{tag_key: 'opening_hours'}`; nominatim object `{lat, lon, address: {country_code, state}}` for holidays/sunrise | verified |
| Weekly intervals | `oh.getOpenIntervals(from, to)` → `[[from, to, unknown, comment], ...]` cropped to range; `getOpenDuration`, `getState(date)`, `getUnknown(date)`, `getNextChange(date, limit)`, `getIterator(date)`, `isWeekStable()`, `getWarnings()`, `prettifyValue()` | verified (README) |
| Python alternative | PyPI `opening-hours-py` 2.1.4 (2026-07-07), licence `MIT OR Apache-2.0`, Rust-backed (`remi-dupre/opening-hours-rs`) | verified (metadata only; API not reviewed) |

---

## 5. gosom/google-maps-scraper (web/REST mode)

| Item | Fact | Status |
|---|---|---|
| Licence | MIT (repo + swagger `info.license`) | verified |
| Latest | `v1.18.1` (2026-09-20); Docker `gosom/google-maps-scraper:latest` / `:v1.18.1` | verified |
| Run web mode | `docker run -v "$PWD/gmapsdata:/gmapsdata" -p 8080:8080 gosom/google-maps-scraper -data-folder /gmapsdata` | verified (README) |
| Mode selection | Web mode if `-web` OR (no `-dsn` and no `-input`) (`runner.go`) | verified |
| Flags | `-web`, `-addr` (default `:8080`), `-data-folder` (default `webdata`), `-proxies`, `-c` | verified |
| API docs | `GET /api/docs` (redoc) | verified |
| Min runtime | README: results take at least 3 minutes | verified |

Endpoints (self-hosted web server, `web/web.go`):

| Method & path | Behaviour |
|---|---|
| `POST /api/v1/jobs` | JSON body → **201** `{"id": "<uuid>"}`; validation error **422** `{"code", "message"}` |
| `GET /api/v1/jobs` | array of all jobs |
| `GET /api/v1/jobs/{id}` | job object (no results); 404 if unknown, 422 if bad id |
| `DELETE /api/v1/jobs/{id}` | delete job |
| `GET /api/v1/jobs/{id}/download` | **CSV only** (`text/csv`, file `<id>.csv` in data folder) |

POST body (`apiScrapeRequest` = `Name` + `JobData`):

| Field | Type | Rules |
|---|---|---|
| `name` (Go field `Name`, no tag; case-insensitive decode) | string | required |
| `keywords` | string[] | required, ≥1 |
| `lang` | string | required, exactly 2 chars |
| `zoom` | int | optional (CLI default 15, range 0–21) |
| `lat`, `lon` | **string** | required if `fast_mode` |
| `fast_mode` | bool | stealth HTTP instead of browser |
| `radius` | int | **metres**; ≤0 → 10000 |
| `depth` | int | required, non-zero |
| `email` | bool | crawl websites for emails |
| `extra_reviews` | bool | |
| `max_time` | int | required, **seconds** (server multiplies by 1s); values < 180 are raised to 180 |
| `proxies` | string[] | optional |

Job object JSON (struct has no json tags → capitalised keys): `ID`, `Name`, `Date`, `Status`, `Data`.
`Status` ∈ `pending`, `working`, `ok`, `failed`. Poll `GET /api/v1/jobs/{id}` until `ok`/`failed`, then
download CSV.

CSV columns (`gmaps/entry.go` `CsvHeaders`): `input_id, link, title, category, address, open_hours,
popular_times, website, phone, plus_code, review_count, review_rating, reviews_per_rating, latitude,
longitude, cid, status, descriptions, reviews_link, thumbnail, timezone, price_range, data_id,
street_view_url, place_id, images, reservations, order_online, menu, owner, complete_address,
credit_cards_accepted, about, user_reviews, user_reviews_extended, emails`. Nested fields
(`open_hours` = map day→[]string, etc.) are stringified in CSV. JSON output (`-json`, CLI only) uses
`web_site` (not `website`) and `categories` list.

Caveat: `api/docs/swagger.yaml` in the repo describes a **different "Pro API"** (`POST /api/v1/scrape`,
fields `keyword`, `geo_coordinates`, `max_depth`, `timeout` 1–300, statuses pending/running/completed/
failed, results inline). That is not the self-hosted `-web` API above — do not mix them.

Legal: README "Legal Notice": "Please use this scraper responsibly and in accordance with applicable laws
and regulations. Unauthorized scraping may violate terms of service." Scraping Google Maps conflicts with
Google Maps Platform/Google ToS (not re-verified here); results carry no open licence. Treat as opt-in,
non-default, with legal review; never mix into the openly licensed datasets without provenance flags.

---

## Open questions

1. FSQ parquet physical types (dates as DATE vs VARCHAR, lat/lon DOUBLE vs DECIMAL) — needs an HF
   token with accepted gate to `DESCRIBE`.
2. FSQ `deltas` table schema and semantics (add/update/delete markers?) — not documented on card.
3. Does an HF token from a user who accepted the gate work for `hf://` in DuckDB without extra steps?
   (Expected yes; not live-tested.)
4. Exact attribution for Overture's own `Overture` / `Overture-signals` source datasets.
5. Azure anonymous access syntax with DuckDB `azure` extension (`az://` vs HTTPS) — untested.
6. Overpass slot count per IP on the main instance (commonly cited as 2) — not stated in docs; main
   instance was at capacity (HTTP 502) on the check date, so plan for self-hosting or a paid instance.
7. `opening_hours` is LGPL-3.0-only: acceptable for our use (dynamic npm dependency) needs a licence
   decision; Python `opening-hours-py` (MIT/Apache) API not yet evaluated.
8. gosom web API: whether `GET /api/v1/jobs/{id}` will ever include results, and the CSV encoding of
   `open_hours` / `emails` — check by running a job.
9. Overture `temporarily_closed` frequency in practice (not seen in the one-file sample).
