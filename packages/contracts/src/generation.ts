import { z } from 'zod';
import { BriefOverridesSchema } from './brief.ts';
import { defineEvent } from './events.ts';
import { BusinessId, SiteId } from './ids.ts';
import { defineJob } from './jobs.ts';
import { CursorPageRequestSchema, cursorPage } from './pagination.ts';

// Site generation (BF-039, ADR-0010): batches of jobs, one per business, each run by an engine (blocks, the Claude
// Agent SDK, Claude Code, Codex — or the fake one in tests) in priority order, with retries, failover, budgets and
// a persisted event log. Engines plug in through the `AgentEngine` port; their events share one shape.

export const ENGINE_IDS = ['blocks', 'claude-agent-sdk', 'claude-code', 'codex', 'fake'] as const;
export const EngineIdSchema = z.enum(ENGINE_IDS);
export type EngineId = z.infer<typeof EngineIdSchema>;
export const EngineRequestSchema = z.union([z.literal('auto'), EngineIdSchema]);
export type EngineRequest = z.infer<typeof EngineRequestSchema>;

export const EngineCapabilitiesSchema = z
  .object({
    /** Runs in a sandbox container (counts against the global sandbox pool). */
    sandboxed: z.boolean(),
    supportsRepair: z.boolean(),
    supportsChatEdit: z.boolean(),
    /** At most this many runs at once, deployment-wide. */
    maxParallel: z.number().int().positive(),
    typicalCostUsd: z.number().nonnegative(),
    typicalDurationSec: z.number().int().positive(),
  })
  .meta({ id: 'EngineCapabilities' });
export type EngineCapabilities = z.infer<typeof EngineCapabilitiesSchema>;

/** What an engine reports while it runs (ARCHITECTURE §11), persisted in order and streamed to the dashboard. */
export const EngineEventSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('status'), phase: z.enum(['preparing', 'running', 'validating']) }),
    z.object({ type: z.literal('progress'), pct: z.number().min(0).max(100), label: z.string().max(200) }),
    z.object({
      type: z.literal('log'),
      level: z.enum(['info', 'warn', 'error']),
      message: z.string().max(2000),
    }),
    z.object({ type: z.literal('tool_call'), tool: z.string().max(100), summary: z.string().max(500) }),
    z.object({ type: z.literal('file_change'), path: z.string().max(300) }),
    z.object({
      type: z.literal('usage'),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative(),
    }),
    z.object({
      type: z.literal('artifact'),
      kind: z.enum(['site_spec', 'screenshot']),
      ref: z.string().max(500),
    }),
    z.object({
      type: z.literal('error'),
      code: z.string().max(60),
      message: z.string().max(1000),
      retryable: z.boolean(),
    }),
    z.object({ type: z.literal('heartbeat') }),
    z.object({ type: z.literal('done'), siteSpecRef: z.string().max(500) }),
  ])
  .meta({ id: 'EngineEvent' });
export type EngineEvent = z.infer<typeof EngineEventSchema>;

/** One event of a job's SSE stream (BF-046): the engine event, its attempt (null: not an attempt's) and time. */
export const GenerationStreamEventSchema = z.intersection(
  EngineEventSchema,
  z.object({ attempt: z.number().int().positive().nullable(), at: z.iso.datetime() }),
);
export type GenerationStreamEvent = z.infer<typeof GenerationStreamEventSchema>;

export const GENERATION_JOB_STATUSES = [
  'queued',
  'preparing',
  'running',
  'validating',
  'repairing',
  'succeeded',
  'needs_review',
  'failed',
  'cancelled',
] as const;
export const GenerationJobStatusSchema = z.enum(GENERATION_JOB_STATUSES);
export type GenerationJobStatus = z.infer<typeof GenerationJobStatusSchema>;
/** No further work happens on its own (a failed job may still be retried by a person). */
export const SETTLED_JOB_STATUSES: readonly GenerationJobStatus[] = [
  'succeeded',
  'needs_review',
  'failed',
  'cancelled',
];

export const GENERATION_BATCH_STATUSES = [
  'queued',
  'running',
  'completed',
  'completed_with_issues',
  'cancelled',
] as const;
export const GenerationBatchStatusSchema = z.enum(GENERATION_BATCH_STATUSES);
export type GenerationBatchStatus = z.infer<typeof GenerationBatchStatusSchema>;

export const GENERATION_ATTEMPT_STATUSES = ['running', 'succeeded', 'failed', 'cancelled'] as const;

const priority = z.number().int().min(1).max(10);
const budget = z.number().positive().max(100);

/** A workspace's generation settings (resolved into each batch as a snapshot). */
export const GenerationSettingsSchema = z
  .object({
    allowedEngines: z.array(EngineIdSchema).min(1),
    defaultEngine: EngineRequestSchema,
    /** Runs at once per engine for this workspace. */
    engineConcurrency: z.partialRecord(EngineIdSchema, z.number().int().min(1).max(20)),
    /** Engines tried in order after the current one fails for good. */
    failoverChain: z.array(EngineIdSchema),
    /** A job's default budget per engine (USD). */
    engineBudgetsUsd: z.partialRecord(EngineIdSchema, budget),
    maxAttemptsPerEngine: z.number().int().min(1).max(5),
    autoPublishPreview: z.boolean(),
    locales: z
      .array(z.string().regex(/^[a-z]{2}$/))
      .min(1)
      .max(5),
  })
  .meta({ id: 'GenerationSettings' });
export type GenerationSettings = z.infer<typeof GenerationSettingsSchema>;

/** A saved engine assignment, e.g. "2 claude-code + 2 codex + rest blocks" (BF-046 create flow). */
export const EngineAssignmentPresetSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().trim().min(1).max(60),
  pattern: z.string().trim().min(1).max(200),
});
export type EngineAssignmentPreset = z.infer<typeof EngineAssignmentPresetSchema>;

export const GENERATION_RUN_MODES = ['parallel', 'sequential'] as const;

/** What a workspace sets for generation (BF-046 Settings → Generation): the engine settings and the UI's defaults. */
export const GenerationWorkspaceSettingsSchema = GenerationSettingsSchema.extend({
  defaultRunMode: z.enum(GENERATION_RUN_MODES),
  presets: z.array(EngineAssignmentPresetSchema).max(20),
}).meta({ id: 'GenerationWorkspaceSettings' });
export type GenerationWorkspaceSettings = z.infer<typeof GenerationWorkspaceSettingsSchema>;

/** `GET /v1/generation/settings`: the workspace's settings and what this deployment allows. */
export const GenerationSettingsViewSchema = z
  .object({
    settings: GenerationWorkspaceSettingsSchema,
    /** Engines registered on this deployment: the ones a workspace may allow. */
    engines: z.array(EngineIdSchema),
    /** Highest per-engine concurrency a workspace may set. */
    maxConcurrency: z.number().int().positive(),
    /** Null while the workspace runs on the defaults. */
    updatedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'GenerationSettingsView' });
export type GenerationSettingsView = z.infer<typeof GenerationSettingsViewSchema>;

export const UpdateGenerationSettingsRequestSchema = GenerationWorkspaceSettingsSchema.meta({
  id: 'UpdateGenerationSettingsRequest',
});
export type UpdateGenerationSettingsRequest = z.infer<typeof UpdateGenerationSettingsRequestSchema>;

export const CreateGenerationBatchRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    items: z
      .array(
        z.object({
          businessId: BusinessId,
          engine: EngineRequestSchema.default('auto'),
          /** 1 is the most urgent. Without one, the item's position decides. */
          priority: priority.optional(),
          budgetUsd: budget.optional(),
          /** An existing site to generate a new version of. */
          siteId: SiteId.optional(),
          /** Adjustments to the brief (BF-040): locales, page plan, style, tone, operator instructions. */
          briefOverrides: BriefOverridesSchema.optional(),
        }),
      )
      .min(1)
      .max(50),
    settings: z
      .object({
        /** 1 runs the batch strictly one job at a time, in priority order; empty is bounded only by the limits. */
        maxParallel: z.number().int().min(1).max(20).optional(),
        autoPublishPreview: z.boolean().optional(),
        locales: z
          .array(z.string().regex(/^[a-z]{2}$/))
          .min(1)
          .max(5)
          .optional(),
        style: z.string().max(40).optional(),
        offer: z.string().max(60).optional(),
        budgetUsd: z.number().positive().max(1000).optional(),
      })
      .default({}),
  })
  .meta({ id: 'CreateGenerationBatchRequest' });
export type CreateGenerationBatchRequest = z.input<typeof CreateGenerationBatchRequestSchema>;

export const GenerationAttemptSchema = z
  .object({
    id: z.uuid(),
    attemptNo: z.number().int().positive(),
    engine: EngineIdSchema,
    mode: z.enum(['create', 'repair']),
    status: z.enum(GENERATION_ATTEMPT_STATUSES),
    costUsd: z.number().nonnegative(),
    exitReason: z.string().nullable(),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'GenerationAttempt' });
export type GenerationAttempt = z.infer<typeof GenerationAttemptSchema>;

export const GenerationJobSchema = z
  .object({
    id: z.uuid(),
    batchId: z.uuid(),
    businessId: BusinessId,
    businessName: z.string(),
    siteId: SiteId.nullable(),
    position: z.number().int().nonnegative(),
    priority,
    engineRequested: EngineRequestSchema,
    engineCurrent: EngineIdSchema,
    engineSelectionReason: z.string(),
    status: GenerationJobStatusSchema,
    attemptCount: z.number().int().nonnegative(),
    budgetUsd: z.number().nonnegative(),
    costUsd: z.number().nonnegative(),
    resultVersionId: z.uuid().nullable(),
    publishedUrl: z.url().nullable(),
    qualityScore: z.number().nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'GenerationJob' });
export type GenerationJob = z.infer<typeof GenerationJobSchema>;

export const GenerationJobDetailSchema = GenerationJobSchema.extend({
  attempts: z.array(GenerationAttemptSchema),
}).meta({ id: 'GenerationJobDetail' });
export type GenerationJobDetail = z.infer<typeof GenerationJobDetailSchema>;

export const GenerationBatchSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    status: GenerationBatchStatusSchema,
    maxParallel: z.number().int().positive().nullable(),
    budgetUsd: z.number().nonnegative().nullable(),
    costUsd: z.number().nonnegative(),
    counts: z.partialRecord(GenerationJobStatusSchema, z.number().int().nonnegative()),
    createdBy: z.string().nullable(),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'GenerationBatch' });
export type GenerationBatch = z.infer<typeof GenerationBatchSchema>;

export const GenerationBatchDetailSchema = GenerationBatchSchema.extend({
  jobs: z.array(GenerationJobSchema),
}).meta({ id: 'GenerationBatchDetail' });
export type GenerationBatchDetail = z.infer<typeof GenerationBatchDetailSchema>;

export const GenerationBatchPageSchema = cursorPage(GenerationBatchSchema).meta({
  id: 'GenerationBatchPage',
});
export type GenerationBatchPage = z.infer<typeof GenerationBatchPageSchema>;
export const GenerationBatchListQuerySchema = CursorPageRequestSchema.extend({
  status: GenerationBatchStatusSchema.optional(),
}).meta({ id: 'GenerationBatchListQuery' });
export type GenerationBatchListQuery = z.infer<typeof GenerationBatchListQuerySchema>;

/** `GET /v1/generation-jobs` (BF-046): the workspace's jobs, newest first — the review queue, a business's jobs. */
export const GenerationJobListQuerySchema = CursorPageRequestSchema.extend({
  status: GenerationJobStatusSchema.optional(),
  businessId: BusinessId.optional(),
}).meta({ id: 'GenerationJobListQuery' });
export type GenerationJobListQuery = z.infer<typeof GenerationJobListQuerySchema>;

export const GenerationJobPageSchema = cursorPage(GenerationJobSchema).meta({ id: 'GenerationJobPage' });
export type GenerationJobPage = z.infer<typeof GenerationJobPageSchema>;

/**
 * What a job's engine was given (BF-046 console, Brief tab): the brief, the facts it may state and the assets it may
 * use, as written into its latest workspace bundle. Shapes are the bundle's (BF-040/BF-042), kept open here.
 */
export const GenerationJobWorkspaceSchema = z
  .object({
    brief: z.record(z.string(), z.unknown()),
    facts: z.array(
      z
        .object({
          id: z.string(),
          kind: z.string(),
          value: z.unknown(),
          display: z.boolean().optional(),
          sourceRef: z.string().optional(),
          observedAt: z.string().optional(),
        })
        .loose(),
    ),
    assets: z.array(z.object({ id: z.string() }).loose()),
    bundle: z.object({
      sha256: z.string(),
      bytes: z.number().int().nonnegative(),
      attemptNo: z.number().int().positive().nullable(),
      createdAt: z.iso.datetime(),
    }),
  })
  .meta({ id: 'GenerationJobWorkspace' });
export type GenerationJobWorkspace = z.infer<typeof GenerationJobWorkspaceSchema>;

export const GENERATION_ARTIFACT_KINDS = [
  'workspace_bundle',
  'site_spec',
  'screenshot',
  'transcript',
  'log_bundle',
] as const;

/** A stored file of a job (BF-046 console, Artifacts tab; `sites:admin`). */
export const GenerationArtifactSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(GENERATION_ARTIFACT_KINDS),
    attemptNo: z.number().int().positive().nullable(),
    sha256: z.string(),
    bytes: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'GenerationArtifact' });
export type GenerationArtifact = z.infer<typeof GenerationArtifactSchema>;

export const GenerationArtifactListSchema = z
  .object({ items: z.array(GenerationArtifactSchema) })
  .meta({ id: 'GenerationArtifactList' });
export type GenerationArtifactList = z.infer<typeof GenerationArtifactListSchema>;

export const UpdateGenerationJobRequestSchema = z
  .object({ priority: priority.optional(), engine: EngineRequestSchema.optional() })
  .refine((body) => body.priority !== undefined || body.engine !== undefined, 'Nothing to change')
  .meta({ id: 'UpdateGenerationJobRequest' });
export type UpdateGenerationJobRequest = z.infer<typeof UpdateGenerationJobRequestSchema>;

export const ReorderGenerationJobsRequestSchema = z
  .object({ batchId: z.uuid(), jobIds: z.array(z.uuid()).min(1).max(50) })
  .meta({ id: 'ReorderGenerationJobsRequest' });
export type ReorderGenerationJobsRequest = z.infer<typeof ReorderGenerationJobsRequestSchema>;

export const RetryGenerationJobRequestSchema = z
  .object({ engine: EngineIdSchema.optional() })
  .meta({ id: 'RetryGenerationJobRequest' });
export type RetryGenerationJobRequest = z.infer<typeof RetryGenerationJobRequestSchema>;

export const GenerationEngineListingSchema = z
  .object({
    items: z.array(
      z.object({
        id: EngineIdSchema,
        available: z.boolean(),
        capabilities: EngineCapabilitiesSchema,
        queued: z.number().int().nonnegative(),
        running: z.number().int().nonnegative(),
      }),
    ),
  })
  .meta({ id: 'GenerationEngineListing' });
export type GenerationEngineListing = z.infer<typeof GenerationEngineListingSchema>;

/** A job changed status (DOMAIN §4): the dashboard, notifications and analytics follow it. */
export const GenerationJobStatusChanged = defineEvent(
  'generation.job.status_changed',
  1,
  z.object({
    jobId: z.uuid(),
    batchId: z.uuid(),
    businessId: BusinessId,
    from: GenerationJobStatusSchema,
    to: GenerationJobStatusSchema,
    engine: EngineIdSchema,
    siteId: SiteId.nullable(),
    versionId: z.uuid().nullable(),
    publishedUrl: z.url().nullable(),
  }),
);

const runShape = { jobId: z.uuid(), attemptNo: z.number().int().positive() };

/**
 * One attempt of a job, on its engine's own queue (`generation-<engine>`; the queue's job id is
 * `<jobId>:<attempt>`, so enqueuing twice is one job).
 */
export const GENERATION_RUN_JOBS = {
  blocks: defineJob('generation-blocks', 'run', runShape),
  'claude-agent-sdk': defineJob('generation-claude-agent-sdk', 'run', runShape),
  'claude-code': defineJob('generation-claude-code', 'run', runShape),
  codex: defineJob('generation-codex', 'run', runShape),
  fake: defineJob('generation-fake', 'run', runShape),
} as const satisfies Record<EngineId, unknown>;

/** The quality gates of an attempt's result (BF-045; schema-only here). */
export const GenerationQualityJob = defineJob('generation-quality', 'evaluate', {
  jobId: z.uuid(),
  attemptId: z.uuid(),
});

/** Every minute: attempts whose heartbeat stopped are failed and retried (a worker died). */
export const GenerationReaperJob = defineJob('generation-reaper', 'reap', {});

/** Realtime message types on the workspace channel (UI notifications, not domain events; throttled per job). */
export const GENERATION_JOB_UPDATED = 'generation.job.updated';
export const GENERATION_BATCH_UPDATED = 'generation.batch.updated';

/** A batch finished (every job settled): its creator is notified. */
export const GenerationBatchCompleted = defineEvent(
  'generation.batch.completed',
  1,
  z.object({
    batchId: z.uuid(),
    createdBy: z.string().nullable(),
    status: GenerationBatchStatusSchema,
    succeeded: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
);

export const RegenerateSiteRequestSchema = z
  .object({
    engine: EngineRequestSchema.default('auto'),
    /** What to change (passed to the engine's brief by BF-040/BF-047). */
    instructions: z.string().trim().max(2000).optional(),
  })
  .meta({ id: 'RegenerateSiteRequest' });
export type RegenerateSiteRequest = z.input<typeof RegenerateSiteRequestSchema>;
