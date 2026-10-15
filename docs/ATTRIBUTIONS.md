# Data attributions

Third-party data shipped with or imported by Business Finder, with the attribution each licence requires. The
in-app attributions page (BF-061) renders this list; keep it in sync when adding a data source.

| Data | Used for | Licence | Required attribution |
|---|---|---|---|
| OpenStreetMap — Saint-Barthélemy island, quarter outlines and place points (`packages/db/seed/geo/bl`) | `bl` geo pack (BF-017) | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) | "© OpenStreetMap contributors" linking to https://www.openstreetmap.org/copyright |
| Nominatim geocoding results (cached in `geocode_cache`, polygons stored as areas) | Location resolution (BF-017) | ODbL 1.0 (OpenStreetMap data) | "© OpenStreetMap contributors" |
| CBS / PDOK postcode-4 areas (imported on demand) | `nl-pc4` geo pack (BF-017) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | "Bron: CBS / PDOK" |
| U.S. Census Bureau TIGER/Line ZCTA5 (imported on demand) | `us-zcta` geo pack (BF-017) | Public domain | None required; credited as "U.S. Census Bureau" |

Derived databases built from ODbL data (e.g. area outlines exported from `geo_areas`) must stay under the ODbL when
published. Provider terms for business data (Google Places, Overture, Foursquare) are covered by ADR-0013.
