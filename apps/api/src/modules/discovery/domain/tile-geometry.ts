import type { BBox, DiscoveryTile, LatLng } from '@bf/contracts';

// Tile helpers shared by providers (BF-018/BF-019): a circle's enclosing box (for box-only sources) and the
// great-circle distance used to drop results from its corners.

const KM_PER_DEGREE_LAT = 110.574;

export function distanceM(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export function circleBounds(center: LatLng, radiusM: number): BBox {
  const dLat = radiusM / 1000 / KM_PER_DEGREE_LAT;
  const dLng = radiusM / 1000 / (111.32 * Math.max(0.01, Math.cos((center.lat * Math.PI) / 180)));
  return {
    west: Math.max(-180, center.lng - dLng),
    south: Math.max(-90, center.lat - dLat),
    east: Math.min(180, center.lng + dLng),
    north: Math.min(90, center.lat + dLat),
  };
}

export const tileBounds = (tile: DiscoveryTile): BBox =>
  tile.type === 'BBox' ? tile.bbox : circleBounds(tile.center, tile.radiusM);

/** Whether a point lies in the tile (points without a location are kept: the tile query selected them). */
export function inTile(location: LatLng | undefined, tile: DiscoveryTile): boolean {
  if (!location) return true;
  if (tile.type === 'Circle') return distanceM(location, tile.center) <= tile.radiusM;
  const { west, south, east, north } = tile.bbox;
  return location.lat >= south && location.lat <= north && location.lng >= west && location.lng <= east;
}
