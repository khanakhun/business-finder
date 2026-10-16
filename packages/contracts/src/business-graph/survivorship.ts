import type { SourceProvider } from '../business.ts';

// Survivorship rules of entity resolution (BF-016): which source's value becomes the golden value of each field.
//
// For a field, the candidate values are those of every source record linked to the business. The winner is:
//   1. a `manual` value, always (workspace corrections are never overwritten by providers — ADR-0008);
//   2. otherwise the source whose provider comes first in the field's priority list (unlisted providers last);
//   3. then the higher confidence, then the newer observation (`observedAt`), then the smaller provider ref.
// Every step is deterministic, so the golden record depends only on the set of sources, never on ingestion order.

export const GOLDEN_FIELDS = [
  'displayName',
  'operatingStatus',
  'websiteUrl',
  'primaryPhone',
  'address',
  'location',
  'priceLevel',
  'rating',
  'hours',
] as const;
export type GoldenFieldName = (typeof GOLDEN_FIELDS)[number];

const PROVIDERS_FIRST: readonly SourceProvider[] = ['manual', 'website', 'google_places', 'foursquare'];

export const SURVIVORSHIP_PRIORITY: Readonly<Record<GoldenFieldName, readonly SourceProvider[]>> = {
  // The business's own site names and reaches it best; then the richest place providers.
  displayName: [...PROVIDERS_FIRST, 'overture', 'osm', 'gmaps_scraper', 'import'],
  primaryPhone: [...PROVIDERS_FIRST, 'overture', 'osm', 'gmaps_scraper', 'import'],
  // Providers link the official site; a crawl's own URL may be a sub-page or a redirect target.
  websiteUrl: [
    'manual',
    'google_places',
    'website',
    'foursquare',
    'overture',
    'osm',
    'gmaps_scraper',
    'import',
  ],
  address: ['manual', 'google_places', 'overture', 'foursquare', 'osm', 'website', 'gmaps_scraper', 'import'],
  location: [
    'manual',
    'google_places',
    'overture',
    'foursquare',
    'osm',
    'gmaps_scraper',
    'website',
    'import',
  ],
  operatingStatus: [
    'manual',
    'google_places',
    'foursquare',
    'overture',
    'osm',
    'gmaps_scraper',
    'website',
    'import',
  ],
  priceLevel: ['manual', 'google_places', 'foursquare', 'gmaps_scraper', 'import'],
  // Ratings only mean something from review platforms; a manual rating is not a thing.
  rating: ['google_places', 'foursquare', 'gmaps_scraper'],
  hours: ['manual', 'website', 'google_places', 'foursquare', 'osm', 'overture', 'gmaps_scraper', 'import'],
};

/** Default confidence of a provider's values when the source does not say (contacts, golden fields). */
export const PROVIDER_CONFIDENCE: Readonly<Record<SourceProvider, number>> = {
  manual: 1,
  website: 0.9,
  google_places: 0.85,
  foursquare: 0.75,
  overture: 0.7,
  osm: 0.7,
  gmaps_scraper: 0.6,
  import: 0.6,
};

/** Rank of `provider` for `field` (lower wins); providers not listed rank after every listed one. */
export function providerRank(field: GoldenFieldName, provider: SourceProvider): number {
  const index = SURVIVORSHIP_PRIORITY[field].indexOf(provider);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}
