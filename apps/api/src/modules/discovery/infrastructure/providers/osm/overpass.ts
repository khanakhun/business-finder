import type { DiscoveryTile } from '@bf/contracts';

// Overpass QL for discovery (BF-019): every element (node/way/relation) carrying one of the category tags in the
// tile, with tags and a centre point for ways and relations. Tag keys/values come from category mappings
// (`key=value`); they are escaped anyway.

/** OSM keys that classify a business (used to pick provider categories from an element's tags). */
export const CATEGORY_KEYS = [
  'amenity',
  'shop',
  'craft',
  'office',
  'tourism',
  'leisure',
  'healthcare',
  'club',
  'sport',
];

const quoteQl = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** `amenity=cafe` → `["amenity"="cafe"]`; `shop` (key only) → `["shop"]`. Invalid keys are skipped. */
export function tagFilter(mapping: string): string | null {
  const [key, ...rest] = mapping.split('=');
  const value = rest.join('=');
  if (!key || !/^[a-z0-9_:]{1,60}$/i.test(key) || value.length > 120) return null;
  return value ? `["${quoteQl(key)}"="${quoteQl(value)}"]` : `["${quoteQl(key)}"]`;
}

const coord = (n: number) => Number(n.toFixed(6));

function area(tile: DiscoveryTile): string {
  if (tile.type === 'BBox') {
    const { south, west, north, east } = tile.bbox;
    return `(${coord(south)},${coord(west)},${coord(north)},${coord(east)})`;
  }
  return `(around:${Math.round(tile.radiusM)},${coord(tile.center.lat)},${coord(tile.center.lng)})`;
}

export function overpassQuery(
  tags: readonly string[],
  tile: DiscoveryTile,
  limit: number,
  timeoutS = 25,
): string {
  const filters = tags.map(tagFilter).filter((f): f is string => f !== null);
  if (filters.length === 0) throw new Error('No valid OSM tag filter');
  const where = area(tile);
  // Only named elements: discovery needs a name to ingest.
  const union = filters.map((f) => `nwr${f}["name"]${where};`).join('');
  return `[out:json][timeout:${timeoutS}];(${union});out center tags ${limit};`;
}
