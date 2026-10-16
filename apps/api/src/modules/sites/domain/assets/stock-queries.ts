// Stock search queries (BF-038): versioned data, one list per category family, with style modifiers. A query names
// a scene, never the business: stock photos are illustrative.

export const STOCK_QUERIES_VERSION = 1;

const BY_CATEGORY: Readonly<Record<string, readonly string[]>> = {
  hair_salon: ['hair salon interior', 'hairdresser tools close-up', 'salon chairs mirror'],
  beauty: ['spa interior calm', 'skincare products marble', 'massage stones towels'],
  restaurant: ['restaurant table setting', 'plated dish close-up', 'restaurant terrace evening'],
  cafe: ['cafe terrace', 'coffee cup latte art', 'pastries display'],
  bar: ['cocktail bar counter', 'cocktails close-up', 'bar terrace sunset'],
  hotel: ['hotel room sea view', 'pool deck loungers', 'hotel lobby interior'],
  villa_rental: ['villa pool ocean view', 'luxury villa terrace', 'bedroom tropical light'],
  real_estate: ['modern villa exterior', 'living room bright', 'ocean view terrace'],
  hardware_store: ['hardware store tools close-up', 'workshop tools wall', 'paint cans shelves'],
  boutique: ['boutique clothing rack', 'fashion store interior', 'accessories display'],
  boat_rental: ['sailboat turquoise water', 'catamaran sea', 'marina boats'],
  default: ['caribbean coastline', 'interior plants light', 'textured wall neutral'],
};

const STYLE_MODIFIERS: Readonly<Record<string, string>> = {
  luxe: 'elegant',
  coastal: 'tropical coastal',
  minimal: 'minimal',
  modern: 'modern',
  warm: 'warm cosy',
};

/** The queries to try for a category (by slug or its family), with the site's style modifier. */
export function stockQueries(category: string | undefined, style: string | undefined): string[] {
  const slug = (category ?? '').toLowerCase();
  const family =
    Object.keys(BY_CATEGORY).find(
      (key) => key !== 'default' && (slug === key || slug.startsWith(`${key}`)),
    ) ?? 'default';
  const modifier = style ? STYLE_MODIFIERS[style] : undefined;
  return (BY_CATEGORY[family] ?? []).map((query) => (modifier ? `${modifier} ${query}` : query));
}

/** One normalized form of a query (cache key and dedupe). */
export const normalizeQuery = (query: string) =>
  query.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 100);
