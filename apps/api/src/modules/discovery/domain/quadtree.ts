import type { DiscoveryTile } from '@bf/contracts';

// Adaptive tiling (BF-020): a saturated tile (the provider returned its maximum) is split in four so dense areas
// are fully covered. Circles split into four circles of 0.75 r centred on the quadrants (they cover the parent:
// the farthest parent point from a child centre is r/√2 ≈ 0.707 r); boxes split into quadrants.

const KM_PER_DEGREE_LAT = 110.574;
const kmPerDegreeLng = (lat: number) => 111.32 * Math.max(0.01, Math.cos((lat * Math.PI) / 180));
const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Smallest circle split: below this a provider saturating means a genuinely dense spot. */
export const MIN_SPLIT_RADIUS_M = 100;

export function splitTile(tile: DiscoveryTile): DiscoveryTile[] {
  if (tile.type === 'BBox') {
    const { west, south, east, north } = tile.bbox;
    const midLng = (west + east) / 2;
    const midLat = (south + north) / 2;
    return [
      { west, south, east: midLng, north: midLat },
      { west: midLng, south, east, north: midLat },
      { west, south: midLat, east: midLng, north },
      { west: midLng, south: midLat, east, north },
    ].map((bbox) => ({ type: 'BBox' as const, bbox }));
  }
  if (tile.radiusM / 2 < MIN_SPLIT_RADIUS_M) return [];
  const offsetKm = tile.radiusM / 2 / 1000;
  const dLat = offsetKm / KM_PER_DEGREE_LAT;
  const dLng = offsetKm / kmPerDegreeLng(tile.center.lat);
  return [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ].map(([x = 0, y = 0]) => ({
    type: 'Circle' as const,
    center: { lat: round(tile.center.lat + y * dLat), lng: round(tile.center.lng + x * dLng) },
    radiusM: Math.round(tile.radiusM * 0.75),
  }));
}

/** Stable text for a tile (dedupe keys). */
export function tileKey(tile: DiscoveryTile): string {
  return tile.type === 'Circle'
    ? `c:${round(tile.center.lat)},${round(tile.center.lng)},${Math.round(tile.radiusM)}`
    : `b:${round(tile.bbox.west)},${round(tile.bbox.south)},${round(tile.bbox.east)},${round(tile.bbox.north)}`;
}
