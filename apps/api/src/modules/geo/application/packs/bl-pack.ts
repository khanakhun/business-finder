import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MultiPolygon } from '@bf/contracts';
import { GEO_SEED_DIR } from '@bf/db/seed';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import { featureCollection, point } from '@turf/helpers';
import { intersect } from '@turf/intersect';
import { voronoi } from '@turf/voronoi';
import type { Feature, MultiPolygon as GeoJsonMultiPolygon, Polygon as GeoJsonPolygon } from 'geojson';
import { normalizeAreaName } from '../../domain/area-names.ts';
import { areaKm2, bboxOf, toMultiPolygon } from '../../domain/geometry.ts';
import type { GeoAreaInput } from '../ports.ts';
import type { GeoPack } from './types.ts';

// Saint-Barthélemy pack (BF-017): the island and its quarters from OpenStreetMap. Quarters are OSM polygons
// (traced from the island's address base, flagged approximate); named hamlets without a polygon get the Voronoi
// cell of their point clipped to the quarter that contains them. Data: seed/geo/bl (© OpenStreetMap
// contributors, ODbL 1.0 — see its README).

interface ExtractFeature {
  readonly type: 'Feature';
  readonly geometry: { type: string; coordinates: unknown };
  readonly properties: {
    readonly kind: string;
    readonly osm: string;
    readonly name?: string;
    readonly name_fr?: string;
    readonly name_en?: string;
    readonly alt_name?: string;
    readonly old_name?: string;
  };
}

/** How people write the island: English, French, short forms, the airport code. */
export const ISLAND_ALIASES = [
  'St Barth',
  'St Barths',
  'St Barts',
  'St Bart',
  'Saint Barth',
  'Saint Barts',
  'Saint Bart',
  'Saint-Barth',
  'St-Barth',
  'St Barthélemy',
  'St-Barthélemy',
  'Saint Barthelemy',
  'Saint Barthélémy',
  'SBH',
  'Ouanalao',
  // The whole island shares one postcode.
  '97133',
] as const;

/** Spellings seen on maps, signs and listings for some quarters (abbreviations like "St" are normalized anyway). */
const QUARTER_ALIASES: Record<string, readonly string[]> = {
  'Grand Cul-de-Sac': ['Grand Cul de Sac', 'Grand-Cul-de-Sac', 'GCDS'],
  'Petit Cul-de-Sac': ['Petit Cul de Sac', 'Petit-Cul-de-Sac'],
  'Saint-Jean': ['Baie de Saint-Jean', 'St Jean Bay'],
  // "Saline" on its own means the Grande Saline beach and pond.
  'Grande Saline': ['Saline', 'Anse de Grande Saline'],
  'Anse des Cayes': ['Anse de Caye', 'Anse des Caye', 'Les Cayes'],
  'Pointe Milou': ['Pointe-Milou'],
  Montjean: ['Mont Jean', 'Mont-Jean'],
  'Grand Fond': ['Grand-Fond'],
  Gustavia: ['Gustavia Harbour', 'Port de Gustavia'],
};

const LOCALITY_KINDS = new Set(['town', 'village', 'city']);

const nameOf = (p: ExtractFeature['properties']) => {
  const base = p.name ?? p.name_fr ?? p.name_en ?? '';
  return { en: p.name_en ?? base, fr: p.name_fr ?? base, local: base };
};

const splitNames = (value: string | undefined) =>
  (value ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

const ownAliases = (p: ExtractFeature['properties']) => [
  ...splitNames(p.alt_name),
  ...splitNames(p.old_name),
  ...(QUARTER_ALIASES[nameOf(p).local] ?? []),
];

export function loadBlExtract(dir = join(GEO_SEED_DIR, 'bl')): ExtractFeature[] {
  const collection = JSON.parse(readFileSync(join(dir, 'osm-extract.geojson'), 'utf8')) as {
    features: ExtractFeature[];
  };
  return collection.features;
}

const samePosition = (a: ExtractFeature, b: ExtractFeature) =>
  JSON.stringify(a.geometry.coordinates) === JSON.stringify(b.geometry.coordinates);

const asFeature = (geometry: MultiPolygon): Feature<GeoJsonMultiPolygon> => ({
  type: 'Feature',
  properties: {},
  geometry: geometry as GeoJsonMultiPolygon,
});

/** Island, quarters (OSM polygons) and hamlets (Voronoi cells within their quarter), parents first. */
export function buildBlAreas(features: readonly ExtractFeature[]): GeoAreaInput[] {
  const islandFeature = features.find((f) => f.properties.kind === 'island');
  if (!islandFeature) throw new Error('BL extract has no island feature');
  const island = toMultiPolygon(islandFeature.geometry as never);
  const islandName = nameOf(islandFeature.properties);
  const islandRef = `bl:${islandFeature.properties.osm}`;
  const areas: GeoAreaInput[] = [
    {
      kind: 'island',
      countryCode: 'BL',
      code: 'BL',
      // Official spellings (OSM's English name drops the accent); OSM's own names stay searchable as aliases.
      name: { en: 'Saint Barthélemy', fr: 'Saint-Barthélemy', local: 'Saint-Barthélemy' },
      aliases: [
        ...new Set(
          [...ISLAND_ALIASES, islandName.en, islandName.fr, islandName.local].filter(
            (n) => n && !['Saint Barthélemy', 'Saint-Barthélemy'].includes(n),
          ),
        ),
      ],
      geometry: island,
      approximate: false,
      source: 'osm',
      sourceRef: islandRef,
    },
  ];

  const points = features.filter((f) => f.geometry.type === 'Point' && nameOf(f.properties).local);
  const pointsByName = new Map<string, ExtractFeature[]>();
  for (const p of points) {
    const key = normalizeAreaName(nameOf(p.properties).local);
    pointsByName.set(key, [...(pointsByName.get(key) ?? []), p]);
  }

  const quarters = features
    .filter((f) => f.properties.kind === 'quarter' && f.geometry.type === 'Polygon' && f.properties.name)
    .map((f) => ({
      feature: f,
      geometry: toMultiPolygon(f.geometry as never),
      ref: `bl:${f.properties.osm}`,
    }));
  const quarterNames = new Set<string>();
  for (const { feature, geometry, ref } of quarters) {
    const name = nameOf(feature.properties);
    // Points named like the quarter or one of its aliases ("Mont Jean" for the polygon's "Montjean") are the same place.
    const keys = [name.local, ...ownAliases(feature.properties)].map(normalizeAreaName);
    for (const key of keys) quarterNames.add(key);
    const samePlace = [...new Set(keys.flatMap((key) => pointsByName.get(key) ?? []))];
    areas.push({
      // A quarter that OSM also maps as a town (Gustavia) is the locality, not just a district.
      kind: samePlace.some((p) => LOCALITY_KINDS.has(p.properties.kind)) ? 'locality' : 'district',
      countryCode: 'BL',
      code: null,
      name: { en: name.en, fr: name.fr, local: name.local },
      aliases: [
        ...new Set([
          ...ownAliases(feature.properties),
          ...samePlace.map((p) => nameOf(p.properties).local).filter((n) => n !== name.local),
          ...samePlace.flatMap((p) => ownAliases(p.properties)),
        ]),
      ],
      parentSourceRef: islandRef,
      // DECISION(BF-017): OSM notes these outlines are derived from the address base pending a better source.
      geometry,
      approximate: true,
      source: 'osm',
      sourceRef: ref,
    });
  }

  // Hamlets: named points without their own polygon, one per name.
  const hamlets = points
    .filter((p) => !quarterNames.has(normalizeAreaName(nameOf(p.properties).local)))
    .filter(
      (p, i, all) =>
        all.findIndex(
          (q) =>
            normalizeAreaName(nameOf(q.properties).local) === normalizeAreaName(nameOf(p.properties).local),
        ) === i,
    )
    // Voronoi gives coincident points no cell: keep the first point at each position.
    .filter((p, i, all) => all.findIndex((q) => samePosition(q, p)) === i);
  if (hamlets.length === 0) return areas;
  const box = bboxOf(island);
  const cells = voronoi(
    featureCollection(hamlets.map((p) => point(p.geometry.coordinates as [number, number]))),
    { bbox: [box.west - 0.01, box.south - 0.01, box.east + 0.01, box.north + 0.01] },
  );
  hamlets.forEach((hamlet, index) => {
    const cell = cells.features[index];
    if (!cell) return;
    const position = hamlet.geometry.coordinates as [number, number];
    // Address-derived outlines can overlap: the smallest containing quarter wins, independent of file order.
    const container = quarters
      .filter((q) => booleanPointInPolygon(position, asFeature(q.geometry)))
      .sort((a, b) => areaKm2(a.geometry) - areaKm2(b.geometry))[0];
    const clipped = intersect(
      featureCollection<GeoJsonPolygon | GeoJsonMultiPolygon>([
        cell,
        asFeature(container?.geometry ?? island),
      ]),
    );
    if (!clipped) return;
    const name = nameOf(hamlet.properties);
    areas.push({
      kind: LOCALITY_KINDS.has(hamlet.properties.kind) ? 'locality' : 'district',
      countryCode: 'BL',
      code: null,
      name: { en: name.en, fr: name.fr, local: name.local },
      aliases: [...new Set(ownAliases(hamlet.properties))],
      parentSourceRef: container?.ref ?? islandRef,
      geometry: toMultiPolygon(clipped.geometry as never) as MultiPolygon,
      approximate: true,
      source: 'osm',
      sourceRef: `bl:${hamlet.properties.osm}`,
    });
  });
  return areas;
}

export const blPack: GeoPack = {
  name: 'bl',
  source:
    'OpenStreetMap contributors (ODbL 1.0) — island and quarter outlines, hamlet points (Voronoi cells)',
  async *areas() {
    for (const area of buildBlAreas(loadBlExtract())) yield area;
  },
};
