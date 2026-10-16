import type { ProviderCostModel, ProviderLicensing } from '@bf/contracts';
import { REVIEW_SOURCE_LICENSING } from '@bf/contracts';

// Google Places licensing and prices as verified on 2026-10-15 (README). Re-check before changing.

/** Days fetched content may be kept (Service Specific Terms §14.3: lat/lng cache ≤ 30 consecutive days). */
export const GOOGLE_RETENTION_DAYS = 30;

export const GOOGLE_PLACES_LICENSING: ProviderLicensing = {
  retentionDays: GOOGLE_RETENTION_DAYS,
  storableFields: ['providerRef'],
  attributionRequired: true,
  attributionText: 'Google Maps',
  commercialUseAllowed: true,
  reviewsUsage: REVIEW_SOURCE_LICENSING.google_places.maxUsage,
  notes:
    'Place IDs may be stored indefinitely (refresh after 12 months). Latitude/longitude may be cached for up to ' +
    '30 days; other Places content may not be cached beyond that, so records expire after 30 days and are only ' +
    'kept where another source confirms the facts (ADR-0013). Reviews and photos are never requested. Not for ' +
    'training AI models; not with a non-Google map. Display "Google Maps" attribution with Google content.',
};

export const GOOGLE_PLACES_COST_MODEL: ProviderCostModel = {
  currency: 'USD',
  skus: [
    {
      sku: 'text_search_essentials',
      label: 'Text Search Essentials (IDs Only)',
      perThousandUsd: 0,
      freeMonthlyCalls: 0,
    },
    { sku: 'text_search_pro', label: 'Text Search Pro', perThousandUsd: 32, freeMonthlyCalls: 5_000 },
    {
      sku: 'text_search_enterprise',
      label: 'Text Search Enterprise',
      perThousandUsd: 35,
      freeMonthlyCalls: 1_000,
    },
    { sku: 'nearby_search_pro', label: 'Nearby Search Pro', perThousandUsd: 32, freeMonthlyCalls: 5_000 },
    {
      sku: 'nearby_search_enterprise',
      label: 'Nearby Search Enterprise',
      perThousandUsd: 35,
      freeMonthlyCalls: 1_000,
    },
  ],
  perResultUsd: null,
  notes:
    'Global list prices per 1,000 calls (first tier, up to 100k/month); free monthly calls are per billing ' +
    'account and SKU. Each results page is a separate call. Verified 2026-10-15.',
};
