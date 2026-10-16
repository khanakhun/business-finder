import { z } from 'zod';
import { defineEvent } from './events.ts';
import { defineJob } from './jobs.ts';
import { SiteIntelSchema } from './site-intel.ts';
import { IsoDateTimeSchema } from './time.ts';

// Enrichment (BF-027, DOMAIN.md glossary): ordered, dependency-aware steps that add facts to a business — site
// intel (BF-026), email verification (BF-028), reviews (BF-029), PageSpeed and visual audit (BF-030). Facts are
// global (one business graph); runs are attributed to the workspace that asked. The database is the source of
// truth for runs and steps; queues execute (ADR-0006).

/** Every step the platform knows. A step that is not registered yet is skipped (`not_registered`). */
export const ENRICHMENT_STEP_IDS = ['site_intel', 'email_verify', 'reviews', 'psi', 'vision_audit'] as const;
export const EnrichmentStepIdSchema = z.enum(ENRICHMENT_STEP_IDS);
export type EnrichmentStepId = z.infer<typeof EnrichmentStepIdSchema>;

export const ENRICHMENT_TRIGGERS = ['discovery', 'manual', 'bulk', 'schedule', 'event'] as const;
export const EnrichmentTriggerSchema = z.enum(ENRICHMENT_TRIGGERS);
export type EnrichmentTrigger = z.infer<typeof EnrichmentTriggerSchema>;

export const ENRICHMENT_RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'partially_completed',
  'failed',
  'cancelled',
] as const;
export const EnrichmentRunStatusSchema = z.enum(ENRICHMENT_RUN_STATUSES);
export type EnrichmentRunStatus = z.infer<typeof EnrichmentRunStatusSchema>;
export const TERMINAL_ENRICHMENT_RUN_STATUSES: readonly EnrichmentRunStatus[] = [
  'completed',
  'partially_completed',
  'failed',
  'cancelled',
];

export const ENRICHMENT_STEP_STATUSES = ['queued', 'running', 'done', 'skipped', 'failed'] as const;
export const EnrichmentStepStatusSchema = z.enum(ENRICHMENT_STEP_STATUSES);
export type EnrichmentStepStatus = z.infer<typeof EnrichmentStepStatusSchema>;

/** Why a step did not run. */
export const ENRICHMENT_SKIP_REASONS = [
  /** Its last output is still within the freshness TTL (re-run with `force`). */
  'fresh',
  'no_website',
  /** The step does not apply to this business (e.g. no e-mail to verify). */
  'not_applicable',
  'dependency_failed',
  'dependency_skipped',
  /** The workspace's monthly enrichment budget would be exceeded. */
  'budget',
  'cancelled',
  /** Not available in this deployment yet (its ticket is not shipped, or it is disabled). */
  'not_registered',
] as const;
export const EnrichmentSkipReasonSchema = z.enum(ENRICHMENT_SKIP_REASONS);
export type EnrichmentSkipReason = z.infer<typeof EnrichmentSkipReasonSchema>;

export const ENRICHMENT_COST_CATEGORIES = ['llm', 'provider', 'free'] as const;
export type EnrichmentCostCategory = (typeof ENRICHMENT_COST_CATEGORIES)[number];

/** Workspace choices for enrichment (`org_settings.enrichment`); unset values take these defaults. */
export const EnrichmentSettingsSchema = z
  .object({
    monthlyBudgetUsd: z
      .number()
      .min(0)
      .max(100_000)
      .nullable()
      .describe('Estimated enrichment spend allowed per calendar month (UTC); null for no workspace cap.'),
    nightlyRefreshLimit: z
      .number()
      .int()
      .min(0)
      .max(5_000)
      .describe('Businesses with stale steps re-enriched per night (0 disables the nightly refresh).'),
  })
  .meta({ id: 'EnrichmentSettings' });
export type EnrichmentSettings = z.infer<typeof EnrichmentSettingsSchema>;

export const DEFAULT_ENRICHMENT_SETTINGS: EnrichmentSettings = {
  monthlyBudgetUsd: null,
  nightlyRefreshLimit: 100,
};

export function resolveEnrichmentSettings(
  stored: Partial<EnrichmentSettings> | undefined,
): EnrichmentSettings {
  return { ...DEFAULT_ENRICHMENT_SETTINGS, ...stored };
}

const Steps = z
  .array(EnrichmentStepIdSchema)
  .min(1)
  .max(ENRICHMENT_STEP_IDS.length)
  .refine((steps) => new Set(steps).size === steps.length, { message: 'Steps must be unique' });

/** `POST /v1/businesses/:id/enrich` (header `Idempotency-Key` recommended). */
export const EnrichBusinessRequestSchema = z
  .object({
    steps: Steps.optional().describe('Default: every registered step. Dependencies are added.'),
    force: z.boolean().default(false).describe('Re-run steps whose last output is still fresh.'),
  })
  .meta({ id: 'EnrichBusinessRequest' });
export type EnrichBusinessRequest = z.input<typeof EnrichBusinessRequestSchema>;

const BusinessIds = z
  .array(z.uuid())
  .min(1)
  .max(500)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'Businesses must be unique' });

/** `POST /v1/enrichment/bulk` and `POST /v1/enrichment/estimate`. */
export const BulkEnrichRequestSchema = z
  .object({
    businessIds: BusinessIds,
    steps: Steps.optional(),
    force: z.boolean().default(false),
  })
  .meta({ id: 'BulkEnrichRequest' });
export type BulkEnrichRequest = z.input<typeof BulkEnrichRequestSchema>;

export const EnrichmentEstimateSchema = z
  .object({
    businesses: z.number().int().min(0),
    steps: z.array(
      z.object({
        step: EnrichmentStepIdSchema,
        willRun: z.number().int().min(0),
        skipped: z.number().int().min(0).describe('Fresh, not applicable or not registered.'),
        costUsd: z.number().min(0),
      }),
    ),
    totalCostUsd: z.number().min(0),
    budget: z.object({
      monthlyBudgetUsd: z.number().nullable(),
      spentUsd: z.number().min(0).describe('Estimated enrichment spend this month (UTC).'),
      remainingUsd: z.number().nullable(),
    }),
    withinBudget: z.boolean(),
  })
  .meta({ id: 'EnrichmentEstimate' });
export type EnrichmentEstimate = z.infer<typeof EnrichmentEstimateSchema>;

export const EnrichmentStepSchema = z
  .object({
    id: z.uuid(),
    step: EnrichmentStepIdSchema,
    status: EnrichmentStepStatusSchema,
    attempt: z.number().int().min(0),
    costUsd: z.number().min(0),
    skipReason: EnrichmentSkipReasonSchema.nullable(),
    error: z.string().nullable(),
    startedAt: IsoDateTimeSchema.nullable(),
    finishedAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'EnrichmentStep' });
export type EnrichmentStep = z.infer<typeof EnrichmentStepSchema>;

export const EnrichmentRunSchema = z
  .object({
    id: z.uuid(),
    businessId: z.uuid(),
    trigger: EnrichmentTriggerSchema,
    requestedSteps: z.array(EnrichmentStepIdSchema),
    force: z.boolean(),
    status: EnrichmentRunStatusSchema,
    costUsd: z.number().min(0),
    error: z.string().nullable(),
    steps: z.array(EnrichmentStepSchema),
    createdAt: IsoDateTimeSchema,
    startedAt: IsoDateTimeSchema.nullable(),
    finishedAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'EnrichmentRun' });
export type EnrichmentRun = z.infer<typeof EnrichmentRunSchema>;

export const BulkEnrichResponseSchema = z
  .object({
    runs: z.array(z.object({ businessId: z.uuid(), runId: z.uuid() })),
    rejected: z.array(
      z.object({
        businessId: z.uuid(),
        reason: z
          .enum(['not_found', 'budget', 'nothing_to_do', 'busy'])
          .describe('`busy`: the workspace already has too many runs waiting.'),
      }),
    ),
  })
  .meta({ id: 'BulkEnrichResponse' });
export type BulkEnrichResponse = z.infer<typeof BulkEnrichResponseSchema>;

/** `GET /v1/businesses/:id/enrichment`: the latest run and where each step stands. */
export const BusinessEnrichmentSchema = z
  .object({
    latestRun: EnrichmentRunSchema.nullable(),
    steps: z.array(
      z.object({
        step: EnrichmentStepIdSchema,
        registered: z.boolean(),
        lastDoneAt: IsoDateTimeSchema.nullable(),
        fresh: z.boolean(),
      }),
    ),
  })
  .meta({ id: 'BusinessEnrichment' });
export type BusinessEnrichment = z.infer<typeof BusinessEnrichmentSchema>;

/** Where a business stands in the listing (search results): from its latest run in this workspace. */
export const ENRICHMENT_LISTING_STATUSES = [
  'none',
  'queued',
  'running',
  'done',
  'partial',
  'failed',
] as const;
export const EnrichmentListingStatusSchema = z.enum(ENRICHMENT_LISTING_STATUSES);
export type EnrichmentListingStatus = z.infer<typeof EnrichmentListingStatusSchema>;

/**
 * `GET /v1/businesses/:id/website`: the latest site-intel snapshot. Page markdown and screenshots stay in object
 * storage (untrusted content is not stored in the database); screenshots are served by
 * `GET /v1/businesses/:id/website/screenshots/{desktop|mobile}`.
 */
export const WebsiteSnapshotSchema = SiteIntelSchema.pick({
  finalUrl: true,
  reachability: true,
  socialOnly: true,
  tls: true,
  security: true,
  languages: true,
  contacts: true,
  socials: true,
  booking: true,
  ordering: true,
  chat: true,
  analytics: true,
  tech: true,
  freshness: true,
  mobile: true,
  performanceHints: true,
  noSolicitation: true,
  logoCandidates: true,
  imageCandidates: true,
})
  .extend({
    id: z.uuid(),
    businessId: z.uuid(),
    url: z.string().max(2_000),
    httpStatus: z.number().int().nullable(),
    fetchedAt: IsoDateTimeSchema,
    pages: z.array(
      SiteIntelSchema.shape.pages.element.omit({ markdownKey: true }).describe('Markdown stays in storage.'),
    ),
    screenshots: z.object({ desktop: z.boolean(), mobile: z.boolean() }),
    noSolicitationMarker: z
      .object({
        firstDetectedAt: IsoDateTimeSchema,
        lastDetectedAt: IsoDateTimeSchema,
        pageUrl: z.string().max(2_000),
        phrases: z.array(z.string().max(200)).max(20),
        snippet: z.string().max(400).nullable(),
      })
      .nullable()
      .describe(
        'Sticky: set when any crawl saw a "do not solicit" statement, even if the latest crawl did not (compliance).',
      ),
  })
  .meta({ id: 'WebsiteSnapshot' });
export type WebsiteSnapshot = z.infer<typeof WebsiteSnapshotSchema>;

// Jobs (ARCHITECTURE §7.1). Steps run when their dependencies are terminal: the run's step rows are the DAG.
export const EnrichmentRunJob = defineJob('enrichment-run', 'start', { runId: z.uuid() });
export const EnrichmentStepJob = defineJob('enrichment-step', 'execute', {
  runId: z.uuid(),
  stepRowId: z.uuid(),
});
/** Nightly refresh of stale steps (one job per UTC day; capped per workspace). */
export const EnrichmentRefreshJob = defineJob('enrichment-refresh', 'refresh', { day: z.iso.date() });

// Events.
export const BusinessEnriched = defineEvent(
  'business.enriched',
  1,
  z.object({
    businessId: z.uuid(),
    runId: z.uuid(),
    steps: z.array(z.object({ id: EnrichmentStepIdSchema, status: EnrichmentStepStatusSchema })),
    changedFields: z.array(z.string()).describe('Golden-record fields the run changed.'),
    noSolicitationDetected: z
      .boolean()
      .describe('The business asks not to be solicited (sticky marker; outreach must not contact it).'),
  }),
);

/** Realtime event types: progress while a run moves (≤ 1/s per run), and one when it finishes. */
export const ENRICHMENT_RUN_PROGRESSED = 'enrichment.run.progressed';
