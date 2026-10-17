import { z } from 'zod';
import { IsoDateTimeSchema } from './time.ts';

// Analytics (BF-058): facts captured from domain events and cost ledgers, a semantic layer of named metrics and
// dimensions (one definition each, used by every dashboard and export), and one query contract.

/** What a fact records (one per business event; `cost` facts come from the LLM and provider ledgers). */
export const ANALYTICS_FACT_TYPES = [
  'business_tracked',
  'score_updated',
  'generation_finished',
  'preview_published',
  'site_viewed',
  'lead_captured',
  'email_sent',
  'email_bounced',
  'unsubscribed',
  'reply_triaged',
  'pipeline_changed',
  'manual_contact',
  'discovery_finished',
  'cost',
] as const;
export const AnalyticsFactTypeSchema = z.enum(ANALYTICS_FACT_TYPES);
export type AnalyticsFactType = z.infer<typeof AnalyticsFactTypeSchema>;

const Localized = z.object({ en: z.string(), fr: z.string() });

export const METRIC_FORMATS = ['count', 'rate', 'usd', 'duration', 'score'] as const;

export const MetricDefinitionSchema = z
  .object({
    id: z.string(),
    label: Localized,
    description: Localized,
    format: z.enum(METRIC_FORMATS),
    /** For rates: the metrics divided (their values are the sample). */
    numerator: z.string().nullable(),
    denominator: z.string().nullable(),
    caveats: Localized.nullable(),
  })
  .meta({ id: 'MetricDefinition' });
export type MetricDefinition = z.infer<typeof MetricDefinitionSchema>;

export const DimensionDefinitionSchema = z
  .object({ id: z.string(), label: Localized, description: Localized, time: z.boolean() })
  .meta({ id: 'DimensionDefinition' });
export type DimensionDefinition = z.infer<typeof DimensionDefinitionSchema>;

export const AnalyticsRegistrySchema = z
  .object({ metrics: z.array(MetricDefinitionSchema), dimensions: z.array(DimensionDefinitionSchema) })
  .meta({ id: 'AnalyticsRegistry' });
export type AnalyticsRegistry = z.infer<typeof AnalyticsRegistrySchema>;

const Name = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);

export const AnalyticsQuerySchema = z
  .object({
    metrics: z.array(Name).min(1).max(10),
    /** At most one time dimension (`day`, `week`, `month`) and three in all. */
    dimensions: z.array(Name).max(3).default([]),
    /** Dimension → the values kept. */
    filters: z.record(Name, z.array(z.string().max(200)).min(1).max(100)).default({}),
    from: IsoDateTimeSchema,
    to: IsoDateTimeSchema,
    /** Time buckets and calendar dimensions in this zone (the workspace's by default). */
    timeZone: z.string().max(60).optional(),
    limit: z.number().int().min(1).max(5_000).default(1_000),
  })
  .meta({ id: 'AnalyticsQuery' });
export type AnalyticsQuery = z.input<typeof AnalyticsQuerySchema>;

export const AnalyticsFreshnessSchema = z.object({
  /** Facts are complete up to this moment. */
  watermark: IsoDateTimeSchema.nullable(),
  lagSeconds: z.number().nullable(),
});
export type AnalyticsFreshness = z.infer<typeof AnalyticsFreshnessSchema>;

export const AnalyticsResultSchema = z
  .object({
    dimensions: z.array(z.string()),
    metrics: z.array(z.string()),
    /** One row per dimension combination: dimension values (strings) and metric values (numbers or null). */
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
    /** Display labels of dimension values (categories, areas, templates…), by dimension then value. */
    labels: z.record(z.string(), z.record(z.string(), z.string())),
    truncated: z.boolean(),
    freshness: AnalyticsFreshnessSchema,
  })
  .meta({ id: 'AnalyticsResult' });
export type AnalyticsResult = z.infer<typeof AnalyticsResultSchema>;

// ── Prebuilt views ──────────────────────────────────────────────────────────────────────────────────────────────

/** The funnel's steps, in order (each a registry metric). */
export const FUNNEL_STEPS = [
  'businesses_discovered',
  'businesses_qualified',
  'previews_published',
  'businesses_contacted',
  'businesses_replied',
  'businesses_positive',
  'meetings',
  'won',
] as const;

export const AnalyticsPeriodQuerySchema = z
  .object({
    from: IsoDateTimeSchema,
    to: IsoDateTimeSchema,
    /** One registry dimension to segment by (the funnel). */
    dimension: Name.optional(),
    timeZone: z.string().max(60).optional(),
  })
  .meta({ id: 'AnalyticsPeriodQuery' });
export type AnalyticsPeriodQuery = z.input<typeof AnalyticsPeriodQuerySchema>;

export const AnalyticsFunnelSchema = z
  .object({
    steps: z.array(z.enum(FUNNEL_STEPS)),
    /** One row per segment (a single row `{ segment: null }` without a dimension). */
    segments: z.array(
      z.object({
        segment: z.string().nullable(),
        label: z.string().nullable(),
        counts: z.array(z.number()),
      }),
    ),
    freshness: AnalyticsFreshnessSchema,
  })
  .meta({ id: 'AnalyticsFunnel' });
export type AnalyticsFunnel = z.infer<typeof AnalyticsFunnelSchema>;

export const AnalyticsCohortsSchema = z
  .object({
    /** By week of first contact (Monday, in the workspace's time zone): what those businesses did since. */
    weeks: z.array(
      z.object({
        week: z.string(),
        contacted: z.number(),
        replied: z.number(),
        positive: z.number(),
        meetings: z.number(),
        won: z.number(),
      }),
    ),
    freshness: AnalyticsFreshnessSchema,
  })
  .meta({ id: 'AnalyticsCohorts' });
export type AnalyticsCohorts = z.infer<typeof AnalyticsCohortsSchema>;

export const AnalyticsTrendsSchema = z
  .object({
    /** Daily totals from the rollup (UTC days): additive measures only. */
    days: z.array(
      z.object({
        day: z.string(),
        businessesDiscovered: z.number(),
        emailsSent: z.number(),
        leads: z.number(),
        pageViews: z.number(),
        previewsPublished: z.number(),
        jobsFinished: z.number(),
        spendUsd: z.number(),
      }),
    ),
    /** The rollup's last refresh. */
    refreshedAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'AnalyticsTrends' });
export type AnalyticsTrends = z.infer<typeof AnalyticsTrendsSchema>;
