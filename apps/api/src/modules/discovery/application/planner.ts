import { createHash } from 'node:crypto';
import type { DiscoveryTile, MultiPolygon, ProviderCapabilities, ProviderQuery } from '@bf/contracts';
import { booleanIntersects } from '@turf/boolean-intersects';
import { circle as turfCircle } from '@turf/circle';
import type { Feature, MultiPolygon as GeoJsonMultiPolygon, Polygon } from 'geojson';
import { tileAsBBoxes, tileAsCircles } from '../../geo/index.ts';
import { splitTile, tileKey } from '../domain/quadtree.ts';

// Discovery planner (BF-020, Strategy per provider capability): initial tiles sized to what one query returns,
// quadtree children for saturated tiles, and stable dedupe keys so planning is idempotent.

export type TileStrategy = 'auto' | 'circles' | 'bboxes';

/** Most tasks one run may hold (planned tiles × categories, plus splits and pages): bounds rows, jobs and memory. */
export const MAX_RUN_TASKS = 20_000;

export interface PlanProfile {
  readonly shape: 'circle' | 'bbox';
  /** Circle radius or box cell size, in km. */
  readonly sizeKm: number;
  /** Quadtree depth allowed below the initial tiles. */
  readonly maxDepth: number;
}

/**
 * Providers that page through every match (open data) get a few large boxes and never split; providers capped
 * at a few dozen results per query (Google, the scraper) get small circles and split when saturated.
 */
export function profileFor(capabilities: ProviderCapabilities, strategy: TileStrategy): PlanProfile {
  const exhaustive = capabilities.pagination && capabilities.maxResultsPerQuery >= 1_000;
  const shape =
    strategy === 'circles' && capabilities.circle
      ? 'circle'
      : strategy === 'bboxes' && capabilities.bbox
        ? 'bbox'
        : exhaustive || !capabilities.circle
          ? 'bbox'
          : 'circle';
  if (shape === 'bbox') return { shape, sizeKm: exhaustive ? 10 : 2, maxDepth: exhaustive ? 0 : 3 };
  return { shape, sizeKm: 1.5, maxDepth: 3 };
}

export function initialTiles(area: MultiPolygon, profile: PlanProfile): DiscoveryTile[] {
  return profile.shape === 'circle'
    ? tileAsCircles(area, profile.sizeKm * 1000)
    : tileAsBBoxes(area, profile.sizeKm).map((t) => ({ type: 'BBox' as const, bbox: t.bbox }));
}

const asFeature = (geometry: Polygon | GeoJsonMultiPolygon): Feature<Polygon | GeoJsonMultiPolygon> => ({
  type: 'Feature',
  properties: {},
  geometry,
});

function tilePolygon(tile: DiscoveryTile): Feature<Polygon> {
  if (tile.type === 'Circle') {
    return turfCircle([tile.center.lng, tile.center.lat], tile.radiusM / 1000, {
      steps: 24,
      units: 'kilometers',
    });
  }
  const { west, south, east, north } = tile.bbox;
  return asFeature({
    type: 'Polygon',
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  }) as Feature<Polygon>;
}

/** Quadtree children of a saturated tile that still touch the run's area. */
export function childTiles(tile: DiscoveryTile, area: MultiPolygon): DiscoveryTile[] {
  const target = asFeature(area as GeoJsonMultiPolygon);
  return splitTile(tile).filter((child) => booleanIntersects(tilePolygon(child), target));
}

/** Idempotency of task creation: same provider, category, query shape, tile and page → same key. */
export function dedupeKey(query: ProviderQuery): string {
  const material = [
    query.provider,
    query.categoryId ?? '-',
    query.mode,
    [...query.providerKeys].sort().join(','),
    query.keywords ?? '',
    tileKey(query.tile),
    query.pageNumber,
  ].join('|');
  return createHash('sha256').update(material).digest('hex').slice(0, 40);
}
