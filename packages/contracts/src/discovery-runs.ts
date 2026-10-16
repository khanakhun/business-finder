import { z } from 'zod';
import {
  DiscoveryIntentSchema,
  DiscoveryTileSchema,
  FieldTierSchema,
  ProviderIdSchema,
} from './discovery.ts';
import { defineEvent } from './events.ts';
import { MultiPolygonSchema } from './geo.ts';
import { CircleGeometrySchema } from './geo-areas.ts';
import { defineJob } from './jobs.ts';
import { CursorPageRequestSchema, cursorPage } from './pagination.ts';
import { IsoDateTimeSchema } from './time.ts';

// Discovery runs (BF-020, DOMAIN.md §3.2): an intent's categories × an area, tiled per provider, fetched with a
// budget, ingested (BF-016) and tracked by the workspace. The database is the source of truth; queues execute.

export const RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'partially_completed',
  'failed',
  'cancelled',
] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'completed',
  'partially_completed',
  'failed',
  'cancelled',
];

/** Why a run ended short of `completed`. */
export const RUN_END_REASONS = [
  'budget',
  'monthly_budget',
  'tasks_failed',
  'cancelled',
  'no_providers',
  'error',
] as const;
export const RunEndReasonSchema = z.enum(RUN_END_REASONS);
export type RunEndReason = z.infer<typeof RunEndReasonSchema>;

export const TASK_STATUSES = ['queued', 'running', 'done', 'failed', 'skipped'] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TILE_STRATEGIES = ['auto', 'circles', 'bboxes'] as const;

export const DiscoveryRunOptionsSchema = z
  .object({
    autoEnrich: z
      .boolean()
      .default(false)
      .describe('Emit `discovery.business_found` for enrichment (BF-027).'),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(20_000)
      .default(2_000)
      .describe('Stop fetching beyond this many records.'),
    fieldTier: FieldTierSchema.optional().describe(
      'Google field tier for this run (workspace setting by default).',
    ),
    tileStrategy: z.enum(TILE_STRATEGIES).default('auto'),
  })
  .meta({ id: 'DiscoveryRunOptions' });
export type DiscoveryRunOptions = z.infer<typeof DiscoveryRunOptionsSchema>;

export const DiscoveryAreaSchema = z
  .union([
    z.object({ areaId: z.uuid() }),
    z.object({ geometry: z.union([MultiPolygonSchema, CircleGeometrySchema]) }),
  ])
  .describe('A stored area (BF-017) or a drawn geometry.');
export type DiscoveryArea = z.infer<typeof DiscoveryAreaSchema>;

export const EstimateDiscoveryRunRequestSchema = z
  .object({
    intent: DiscoveryIntentSchema,
    area: DiscoveryAreaSchema,
    providers: z
      .array(ProviderIdSchema)
      .min(1)
      .max(6)
      .optional()
      .describe('Default: the workspace selection.'),
    budgetUsd: z.number().min(0).max(10_000).optional().describe('Default: the workspace run budget.'),
    options: DiscoveryRunOptionsSchema.default({
      autoEnrich: false,
      maxResults: 2_000,
      tileStrategy: 'auto',
    }),
  })
  .refine((r) => r.intent.categoryIds.length > 0 || r.intent.keywords, {
    message: 'Ask for categories or keywords',
    path: ['intent'],
  })
  .meta({ id: 'EstimateDiscoveryRunRequest' });
export type EstimateDiscoveryRunRequest = z.infer<typeof EstimateDiscoveryRunRequestSchema>;

export const StartDiscoveryRunRequestSchema = EstimateDiscoveryRunRequestSchema.meta({
  id: 'StartDiscoveryRunRequest',
});
export type StartDiscoveryRunRequest = z.infer<typeof StartDiscoveryRunRequestSchema>;

const RangeSchema = z.object({ min: z.number().min(0), expected: z.number().min(0), max: z.number().min(0) });

export const ProviderEstimateSchema = z.object({
  provider: ProviderIdSchema,
  tiles: z.number().int().min(0),
  tasks: z.number().int().min(0),
  calls: RangeSchema,
  costUsd: RangeSchema,
  results: z.object({ min: z.number().int().min(0), max: z.number().int().min(0) }),
});

export const DiscoveryRunEstimateSchema = z
  .object({
    providers: z.array(ProviderEstimateSchema),
    excluded: z.array(z.object({ provider: ProviderIdSchema, reason: z.string() })),
    totals: z.object({ tasks: z.number().int(), calls: RangeSchema, costUsd: RangeSchema }),
    budgetUsd: z.number().min(0),
    warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  })
  .meta({ id: 'DiscoveryRunEstimate' });
export type DiscoveryRunEstimate = z.infer<typeof DiscoveryRunEstimateSchema>;

export const RunCountsSchema = z
  .object({
    tasksTotal: z.number().int().min(0),
    tasksDone: z.number().int().min(0),
    tasksFailed: z.number().int().min(0),
    tasksSkipped: z.number().int().min(0),
    recordsFetched: z.number().int().min(0),
    created: z.number().int().min(0),
    merged: z.number().int().min(0),
    unchanged: z.number().int().min(0),
    possibleDuplicates: z.number().int().min(0),
    failedRecords: z.number().int().min(0),
  })
  .meta({ id: 'RunCounts' });
export type RunCounts = z.infer<typeof RunCountsSchema>;

export const DiscoveryRunSchema = z
  .object({
    id: z.uuid(),
    status: RunStatusSchema,
    reason: RunEndReasonSchema.nullable(),
    intent: DiscoveryIntentSchema,
    areaId: z.uuid().nullable(),
    providers: z.array(ProviderIdSchema),
    options: DiscoveryRunOptionsSchema,
    budgetUsd: z.number(),
    costUsd: z.number(),
    counts: RunCountsSchema,
    createdBy: z.string().nullable(),
    startedAt: IsoDateTimeSchema.nullable(),
    finishedAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'DiscoveryRun' });
export type DiscoveryRun = z.infer<typeof DiscoveryRunSchema>;

export const DiscoveryRunPageSchema = cursorPage(DiscoveryRunSchema).meta({ id: 'DiscoveryRunPage' });
export type DiscoveryRunPage = z.infer<typeof DiscoveryRunPageSchema>;
export const DiscoveryRunQuerySchema = CursorPageRequestSchema.extend({ status: RunStatusSchema.optional() });
export type DiscoveryRunQuery = z.output<typeof DiscoveryRunQuerySchema>;

export const DiscoveryTaskSchema = z
  .object({
    id: z.uuid(),
    provider: ProviderIdSchema,
    categoryId: z.uuid().nullable(),
    tile: DiscoveryTileSchema,
    depth: z.number().int().min(0),
    pageNumber: z.number().int().min(0),
    status: TaskStatusSchema,
    attempt: z.number().int().min(0),
    records: z.number().int().min(0),
    saturated: z.boolean(),
    costUsd: z.number(),
    error: z.string().nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'DiscoveryTask' });
export const DiscoveryTaskPageSchema = cursorPage(DiscoveryTaskSchema).meta({ id: 'DiscoveryTaskPage' });
export type DiscoveryTaskPage = z.infer<typeof DiscoveryTaskPageSchema>;

export const RunBusinessSchema = z
  .object({
    businessId: z.uuid(),
    name: z.string(),
    primaryCategoryId: z.uuid().nullable(),
    locality: z.string().nullable(),
    trackedAt: IsoDateTimeSchema,
  })
  .meta({ id: 'RunBusiness' });
export const RunBusinessPageSchema = cursorPage(RunBusinessSchema).meta({ id: 'RunBusinessPage' });
export type RunBusinessPage = z.infer<typeof RunBusinessPageSchema>;

// Jobs (one queue per step: separate concurrency, ARCHITECTURE §7.1).
export const DiscoveryPlanJob = defineJob('discovery-plan', 'plan', { runId: z.uuid() });
export const DiscoveryFetchJob = defineJob('discovery-fetch', 'fetch', { runId: z.uuid(), taskId: z.uuid() });
/** Ingests a fetched page; its records wait on the task row (`pending_records`), not in the queue. */
export const DiscoveryIngestJob = defineJob('discovery-ingest', 'ingest', {
  runId: z.uuid(),
  taskId: z.uuid(),
});

// Events.
export const DiscoveryRunCompleted = defineEvent(
  'discovery.run.completed',
  1,
  z.object({
    runId: z.uuid(),
    status: RunStatusSchema,
    reason: RunEndReasonSchema.nullable(),
    createdBy: z.string().nullable(),
    counts: RunCountsSchema,
    costUsd: z.number(),
  }),
);
export const DiscoveryBusinessFound = defineEvent(
  'discovery.business.found',
  1,
  z.object({ runId: z.uuid(), businessId: z.uuid() }),
);

/** Realtime event types (≤ 1/s per run while running; one on completion). */
export const DISCOVERY_RUN_PROGRESSED = 'discovery.run.progressed';
export const DISCOVERY_RUN_FINISHED = 'discovery.run.completed';
