import { z } from 'zod';

// Provider ids and workspace discovery settings (BF-018), kept free of other contract imports: workspace settings
// embed them, and business/source-record contracts import workspace ones.

export const DISCOVERY_PROVIDER_IDS = [
  'google_places',
  'overture',
  'foursquare',
  'osm',
  'gmaps_scraper',
  /** Fixture records for tests and E2E only (never registered in production). */
  'fake',
] as const;
export const ProviderIdSchema = z.enum(DISCOVERY_PROVIDER_IDS);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

/** Response detail a paid provider returns, and so the SKU it bills (Google: Essentials / Pro / Enterprise). */
export const FIELD_TIERS = ['essentials', 'pro', 'enterprise'] as const;
export const FieldTierSchema = z.enum(FIELD_TIERS);
export type FieldTier = z.infer<typeof FieldTierSchema>;

/** Workspace choices for discovery (`org_settings.discovery`); unset values take these defaults. */
export const DiscoverySettingsSchema = z
  .object({
    providerOrder: z
      .array(ProviderIdSchema)
      .max(DISCOVERY_PROVIDER_IDS.length)
      .describe('Preferred providers first (ADR-0013: open data, then official APIs, then opt-in scrapers).'),
    disabledProviders: z.array(ProviderIdSchema).max(DISCOVERY_PROVIDER_IDS.length),
    googleFieldTier: FieldTierSchema.describe(
      'Response detail requested from Google Places (and so its SKU).',
    ),
    overtureRelease: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}\.\d{1,3}$/)
      .nullable()
      .describe('Pinned Overture release (e.g. 2026-09-23.1); null follows the latest release.'),
    runBudgetUsd: z
      .number()
      .min(0)
      .max(10_000)
      .describe('Default budget of one discovery run (a run never spends more).'),
    monthlyBudgetUsd: z
      .number()
      .min(0)
      .max(100_000)
      .nullable()
      .describe('Provider spend allowed per calendar month (UTC); null for no workspace cap.'),
  })
  .meta({ id: 'DiscoverySettings' });
export type DiscoverySettings = z.infer<typeof DiscoverySettingsSchema>;

export const DEFAULT_DISCOVERY_SETTINGS: DiscoverySettings = {
  providerOrder: ['overture', 'foursquare', 'osm', 'google_places', 'gmaps_scraper'],
  disabledProviders: [],
  googleFieldTier: 'pro',
  overtureRelease: null,
  runBudgetUsd: 5,
  monthlyBudgetUsd: null,
};

/** Stored choices over the defaults; providers missing from the stored order keep their default rank after it. */
export function resolveDiscoverySettings(stored: Partial<DiscoverySettings> | undefined): DiscoverySettings {
  const order = [...new Set(stored?.providerOrder ?? [])];
  return {
    ...DEFAULT_DISCOVERY_SETTINGS,
    ...stored,
    providerOrder: [
      ...order,
      ...DEFAULT_DISCOVERY_SETTINGS.providerOrder.filter((id) => !order.includes(id)),
    ],
    disabledProviders: [...new Set(stored?.disabledProviders ?? [])],
  };
}
