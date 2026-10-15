# Saint-Barthélemy geo extract

`osm-extract.geojson` feeds the `bl` geo pack (`pnpm geo:import --pack bl`, BF-017).

**Data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).** If you publish data derived
from it (e.g. area outlines), attribute OpenStreetMap and keep the derived database under the ODbL.

## Contents

| Feature | `kind` | OSM source |
|---|---|---|
| Main island outline (islets excluded) | `island` | relation 7552779 (`place=island`) |
| Quarter outlines | `quarter` | ways tagged `place=quarter` (traced from the island's address base; OSM notes they await a better source) |
| Town and hamlet points | `town`, `neighbourhood` | nodes tagged `place=town` / `place=neighbourhood` |

Properties: `osm` (`<type>/<id>`), `name`, and when tagged `name_fr`, `name_en`, `alt_name`, `old_name`.
Coordinates are rounded to 6 decimals (~0.1 m); exterior rings are counter-clockwise (RFC 7946).

## Refreshing

Extracted on 2026-10-15 from the OSM API (`/api/0.6/relation/7552779/full` and `/api/0.6/map` bbox tiles over
the island, splitting tiles above the 50,000-node limit) because public Overpass instances were unavailable. An
equivalent Overpass query:

```
[out:json][timeout:60];
(
  rel(7552779);
  way["place"="quarter"](17.85,-62.96,17.98,-62.78);
  node["place"~"^(town|neighbourhood)$"](17.85,-62.96,17.98,-62.78);
);
out geom;
```

Convert the result to the shape above (island as MultiPolygon, quarters as Polygons, places as Points), then run
`pnpm --filter @bf/api test -- bl-pack` to check the pack still builds.
