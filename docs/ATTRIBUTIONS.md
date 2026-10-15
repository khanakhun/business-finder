# Data attributions

Third-party data shipped with or imported by Business Finder, with the attribution each licence requires. The
in-app attributions page (BF-061) renders this list; keep it in sync when adding a data source.

| Data | Used for | Licence | Required attribution |
|---|---|---|---|
| OpenStreetMap — Saint-Barthélemy island, quarter outlines and place points (`packages/db/seed/geo/bl`) | `bl` geo pack (BF-017) | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) | "© OpenStreetMap contributors" linking to https://www.openstreetmap.org/copyright |
| Nominatim geocoding results (cached in `geocode_cache`, polygons stored as areas) | Location resolution (BF-017) | ODbL 1.0 (OpenStreetMap data) | "© OpenStreetMap contributors" |
| CBS / PDOK postcode-4 areas (imported on demand) | `nl-pc4` geo pack (BF-017) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | "Bron: CBS / PDOK" |
| U.S. Census Bureau TIGER/Line ZCTA5 (imported on demand) | `us-zcta` geo pack (BF-017) | Public domain | None required; credited as "U.S. Census Bureau" |
| Overture Maps Places (queried in services/intel, stored as source records) | `overture` discovery provider (BF-019) | Per source (`sources[].license`): CDLA-Permissive-2.0 (Meta, Microsoft, …), Apache-2.0 (Foursquare), CC0-1.0 (AllThePlaces) | "Overture Maps Foundation (overturemaps.org)" plus, per record source, e.g. "Data from Meta. Available under CDLA Permissive 2.0." |
| Foursquare OS Places (Hugging Face, gated) | `foursquare` discovery provider (BF-019) | Apache-2.0 | "Copyright 2024 Foursquare Labs, Inc." with the licence/NOTICE |
| OpenStreetMap via Overpass | `osm` discovery provider (BF-019) | ODbL 1.0 | "© OpenStreetMap contributors" linking to https://www.openstreetmap.org/copyright |
| Google Places API (New) | `google_places` provider (BF-018) | Google Maps Platform terms (not open) | "Google Maps" (logo where possible) next to Google content |
| disposable-email-domains list (`business-graph/domain/value-objects/disposable-domains.data.ts`, pinned commit) | Disposable e-mail classification (BF-028) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | None required; credited as "disposable-email-domains contributors" |
| Google Maps scraper (gosom, self-hosted, off by default) | `gmaps_scraper` provider (BF-019) | No licence (likely breaches Google ToS) | Not attributable: never published; records expire after 30 days |

Derived databases built from ODbL data (e.g. area outlines exported from `geo_areas`) must stay under the ODbL when
published. Provider terms for business data (Google Places, Overture, Foursquare) are covered by ADR-0013.
