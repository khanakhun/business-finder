import type { FieldTier } from '@bf/contracts';

// Field masks per tier (README "Field mask presets"): Google bills a call at the highest SKU any requested field
// triggers, so each preset stops at its tier. Atmosphere fields (reviews, photos, summaries) are never requested.

export type GoogleEndpoint = 'text' | 'nearby';

const PRO_FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.shortFormattedAddress',
  'places.addressComponents',
  'places.postalAddress',
  'places.location',
  'places.types',
  'places.primaryType',
  'places.primaryTypeDisplayName',
  'places.businessStatus',
  'places.googleMapsUri',
  'places.utcOffsetMinutes',
  'places.attributions',
];
const ENTERPRISE_FIELDS = [
  ...PRO_FIELDS,
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.rating',
  'places.userRatingCount',
  'places.regularOpeningHours',
  'places.priceLevel',
];
/** Text Search "IDs Only" (no charge): used for connection tests, never for discovery records (no names). */
export const ID_ONLY_TEXT_MASK = 'places.id,nextPageToken';

/**
 * Discovery needs at least names and locations, so `essentials` (IDs only) is served as `pro`.
 * DECISION(BF-018): documented in the README; the setting still lets a workspace pick the cheapest useful tier.
 */
export const effectiveTier = (tier: FieldTier): Exclude<FieldTier, 'essentials'> =>
  tier === 'essentials' ? 'pro' : tier;

export function fieldMask(endpoint: GoogleEndpoint, tier: FieldTier): string {
  const fields = effectiveTier(tier) === 'enterprise' ? ENTERPRISE_FIELDS : PRO_FIELDS;
  // Only Text Search pages; `nextPageToken` is an IDs-only field and adds no cost.
  return (endpoint === 'text' ? [...fields, 'nextPageToken'] : fields).join(',');
}

/** Billing SKU of a call (names match the cost model). */
export const skuFor = (endpoint: GoogleEndpoint, tier: FieldTier): string =>
  `${endpoint === 'text' ? 'text_search' : 'nearby_search'}_${effectiveTier(tier)}`;
