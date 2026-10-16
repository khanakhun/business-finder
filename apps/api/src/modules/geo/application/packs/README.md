# Geo packs (BF-017)

`pnpm geo:import --pack <name> [--file <path>] [--prefix <digits>]` loads a pack into `geo_areas`. Every pack is
idempotent: areas upsert by `(source, source_ref)`, so re-running only rewrites what changed. `pnpm geo:import --list`
prints each pack with its source and licence.

| Pack | Areas | Source and licence | Input |
|---|---|---|---|
| `bl` | Saint-Barthélemy island, quarters, hamlets | © OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) | committed extract, see `packages/db/seed/geo/bl/README.md` |
| `nl-pc4` | Dutch 4-digit postcode areas | CBS / PDOK, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | `--file` (GeoJSONSeq) |
| `us-zcta` | US ZIP Code Tabulation Areas | U.S. Census Bureau TIGER/Line (public domain) | `--file` (GeoJSONSeq), optional `--prefix` |

National packs are large (≈4,000 PC4 areas, ≈33,000 ZCTAs), so they are not committed: download the open data,
convert it to a GeoJSON Text Sequence in WGS84 with GDAL, and stream it in. The importer reads one feature per line
and never loads the whole file.

## nl-pc4

Download the CBS postcode-4 statistics (e.g. `cbs_pc4_2024_vol.gpkg`) from
[CBS / PDOK](https://www.cbs.nl/nl-nl/dossier/nederland-regionaal/geografische-data/gegevens-per-postcode), then:

```sh
ogr2ogr -f GeoJSONSeq -t_srs EPSG:4326 -select postcode pc4.geojsonseq cbs_pc4_2024_vol.gpkg
pnpm geo:import --pack nl-pc4 --file pc4.geojsonseq
```

The postcode is read from the `postcode` (or `pc4`) property. Attribution required: "Bron: CBS / PDOK".

## us-zcta

Download the national ZCTA shapefile (`tl_2024_us_zcta520.zip`) from
[Census TIGER/Line](https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html), then:

```sh
ogr2ogr -f GeoJSONSeq -t_srs EPSG:4326 -select ZCTA5CE20 zcta.geojsonseq /vsizip/tl_2024_us_zcta520.zip
pnpm geo:import --pack us-zcta --file zcta.geojsonseq --prefix 33   # e.g. South Florida only
```

ZCTAs carry no state, so `--prefix` (leading ZIP digits) narrows the import instead of the `--state` option the
ticket sketched; ZIP prefixes map to states and regions (`33`/`34` Florida, `10` Manhattan, …).

## Adding a pack

Implement `GeoPack` (`types.ts`): yield `GeoAreaInput`s with a stable `sourceRef`, parents before children
(`parentSourceRef`), and set `approximate` when the outline is derived rather than surveyed. Register it in
`index.ts`, document its source and licence here, and add it to `docs/ATTRIBUTIONS.md`.
