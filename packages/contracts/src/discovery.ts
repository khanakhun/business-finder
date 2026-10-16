import { z } from 'zod';
import { SourceRecordSchema } from './business-graph/source-record.ts';
import { DISCOVERY_PROVIDER_IDS, FieldTierSchema, ProviderIdSchema } from './discovery-settings.ts';
import { BBoxSchema } from './geo.ts';
import { CircleGeometrySchema } from './geo-areas.ts';

export {
  DEFAULT_DISCOVERY_SETTINGS,
  DISCOVERY_PROVIDER_IDS,
  type DiscoverySettings,
  DiscoverySettingsSchema,
  FIELD_TIERS,
  type FieldTier,
  FieldTierSchema,
  type ProviderId,
  ProviderIdSchema,
  resolveDiscoverySettings,
} from './discovery-settings.ts';

// Discovery providers (BF-018, ADR-0013): what each external source can do, what it costs and what its licence
// lets us keep. Runs, plans and budgets per run come with BF-020.

/** One provider query covers a circle or a bounding box (tiles from BF-017). */
export const DiscoveryTileSchema = z
  .discriminatedUnion('type', [CircleGeometrySchema, z.object({ type: z.literal('BBox'), bbox: BBoxSchema })])
  .meta({ id: 'DiscoveryTile' });
export type DiscoveryTile = z.infer<typeof DiscoveryTileSchema>;

export const ProviderCapabilitiesSchema = z
  .object({
    textQuery: z.boolean().describe('Accepts free-text keywords.'),
    categoryFilter: z.boolean().describe('Filters by provider category keys.'),
    circle: z.boolean(),
    bbox: z.boolean(),
    polygon: z.boolean(),
    maxResultsPerQuery: z
      .number()
      .int()
      .positive()
      .describe('Most results one query can return across pages: reaching it means the tile is saturated.'),
    pagination: z.boolean(),
  })
  .meta({ id: 'ProviderCapabilities' });
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const ProviderLicensingSchema = z
  .object({
    retentionDays: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe('How long fetched content may be kept; null when there is no limit.'),
    storableFields: z
      .array(z.string())
      .describe('Fields that may be kept indefinitely even when content expires (e.g. the place id).'),
    attributionRequired: z.boolean(),
    attributionText: z.string().nullable(),
    commercialUseAllowed: z.boolean(),
    notes: z.string(),
  })
  .meta({ id: 'ProviderLicensing' });
export type ProviderLicensing = z.infer<typeof ProviderLicensingSchema>;

export const ProviderSkuSchema = z
  .object({
    sku: z.string().describe('Provider billing SKU, e.g. `text_search_pro`.'),
    label: z.string(),
    perThousandUsd: z.number().min(0).describe('Price per 1,000 calls at the first volume tier.'),
    freeMonthlyCalls: z.number().int().min(0).describe('Calls per month at no charge (per billing account).'),
  })
  .meta({ id: 'ProviderSku' });
export type ProviderSku = z.infer<typeof ProviderSkuSchema>;

export const ProviderCostModelSchema = z
  .object({
    currency: z.literal('USD'),
    skus: z.array(ProviderSkuSchema),
    perResultUsd: z.number().min(0).nullable(),
    notes: z.string(),
  })
  .meta({ id: 'ProviderCostModel' });
export type ProviderCostModel = z.infer<typeof ProviderCostModelSchema>;

/** What a discovery asks for: categories (taxonomy ids) and/or keywords, in a language and region. */
export const DiscoveryIntentSchema = z
  .object({
    categoryIds: z.array(z.uuid()).max(50).default([]),
    keywords: z.string().trim().min(1).max(200).optional(),
    languageCode: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
    regionCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
  })
  .meta({ id: 'DiscoveryIntent' });
export type DiscoveryIntent = z.infer<typeof DiscoveryIntentSchema>;

/** One provider call: built by the provider from an intent and a tile, then paged by the run (BF-020). */
export const ProviderQuerySchema = z
  .object({
    provider: ProviderIdSchema,
    /** Taxonomy category this query serves (null for keyword-only queries). */
    categoryId: z.uuid().nullable(),
    providerKeys: z.array(z.string().min(1).max(200)).max(50),
    tile: DiscoveryTileSchema,
    keywords: z.string().max(200).optional(),
    languageCode: z.string(),
    regionCode: z.string().optional(),
    fieldTier: FieldTierSchema,
    /** Provider-specific endpoint/mode (e.g. Google `text` or `nearby`). */
    mode: z.string().max(40),
    pageToken: z.string().max(4_000).optional(),
    /** 0-based page number (saturation is judged on the last page). */
    pageNumber: z.number().int().min(0).default(0),
  })
  .meta({ id: 'ProviderQuery' });
export type ProviderQuery = z.infer<typeof ProviderQuerySchema>;

export const ProviderPageSchema = z
  .object({
    records: z.array(SourceRecordSchema),
    nextPageToken: z.string().nullable(),
    /** The query returned the provider's maximum: the planner should split the tile (BF-020). */
    saturated: z.boolean(),
    sku: z.string(),
    callCostUsd: z.number().min(0).describe('Estimated cost of this call after free monthly usage.'),
  })
  .meta({ id: 'ProviderPage' });
export type ProviderPage = z.infer<typeof ProviderPageSchema>;

export const PROVIDER_STATUSES = ['ready', 'not_configured', 'disabled', 'unavailable'] as const;
export const ProviderStatusSchema = z.enum(PROVIDER_STATUSES);
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const DiscoveryProviderSummarySchema = z
  .object({
    id: ProviderIdSchema,
    label: z.string(),
    status: ProviderStatusSchema.describe(
      'ready; not_configured (its secret is missing); disabled (by the workspace); unavailable (feature off).',
    ),
    secretName: z.string().nullable().describe('Vault secret the provider needs, if any.'),
    preferenceRank: z.number().int().min(0).describe('Position in the workspace preference order (0 first).'),
    capabilities: ProviderCapabilitiesSchema,
    licensing: ProviderLicensingSchema,
    costModel: ProviderCostModelSchema,
  })
  .meta({ id: 'DiscoveryProviderSummary' });
export type DiscoveryProviderSummary = z.infer<typeof DiscoveryProviderSummarySchema>;

export const DiscoveryProviderListSchema = z
  .object({ items: z.array(DiscoveryProviderSummarySchema) })
  .meta({ id: 'DiscoveryProviderList' });
export type DiscoveryProviderList = z.infer<typeof DiscoveryProviderListSchema>;

const IsoDateSchema = z.iso.date();

export const ProviderUsageQuerySchema = z
  .object({ from: IsoDateSchema, to: IsoDateSchema })
  .refine((q) => q.from <= q.to, { message: 'from must be on or before to', path: ['from'] })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 366 * 86_400_000, {
    message: 'At most one year',
    path: ['to'],
  });
export type ProviderUsageQuery = z.infer<typeof ProviderUsageQuerySchema>;

export const ProviderUsageRowSchema = z
  .object({
    day: IsoDateSchema,
    provider: ProviderIdSchema,
    sku: z.string(),
    calls: z.number().int().min(0),
    results: z.number().int().min(0),
    costUsd: z.number().min(0),
  })
  .meta({ id: 'ProviderUsageRow' });
export type ProviderUsageRow = z.infer<typeof ProviderUsageRowSchema>;

export const ProviderUsageReportSchema = z
  .object({
    from: IsoDateSchema,
    to: IsoDateSchema,
    rows: z.array(ProviderUsageRowSchema),
    totals: z.object({ calls: z.number().int(), results: z.number().int(), costUsd: z.number() }),
  })
  .meta({ id: 'ProviderUsageReport' });
export type ProviderUsageReport = z.infer<typeof ProviderUsageReportSchema>;
