import type { DefaultJobOptions } from 'bullmq';

/** Defaults for every queue: retries with exponential backoff, bounded history (ADR-0006). */
export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/**
 * Jobs BullMQ attempts once because their domain owns retries: generation runs (retries and failover are the
 * orchestrator's, often on another engine) and outbound sends (reconciled before any new attempt, BF-052).
 */
export const SINGLE_ATTEMPT_JOB_OPTIONS: DefaultJobOptions = { ...DEFAULT_JOB_OPTIONS, attempts: 1 };
export const GENERATION_JOB_OPTIONS = SINGLE_ATTEMPT_JOB_OPTIONS;

export interface QueueDefinition {
  readonly name: string;
  readonly defaultJobOptions: DefaultJobOptions;
  /** Jobs processed in parallel per worker process. */
  readonly concurrency: number;
}

/** Every queue in the system. Feature tickets add theirs here; jobs are declared in @bf/contracts (`defineJob`). */
export const QUEUES = {
  system: { name: 'system', defaultJobOptions: DEFAULT_JOB_OPTIONS, concurrency: 5 },
  /** Outbox deliveries, one job per event × subscriber (BF-012): more attempts, since subscribers may hit transient errors. */
  events: {
    name: 'events',
    defaultJobOptions: {
      ...DEFAULT_JOB_OPTIONS,
      attempts: 8,
      backoff: { type: 'exponential', delay: 2_000 },
    },
    concurrency: 10,
  },
  /** Taxonomy maintenance (BF-015): category embeddings. One at a time: runs are idempotent and rare. */
  taxonomy: { name: 'taxonomy', defaultJobOptions: DEFAULT_JOB_OPTIONS, concurrency: 1 },
  /** Discovery runs (BF-020): planning, provider fetches (rate-limited per provider key), ingestion. */
  discoveryPlan: { name: 'discovery-plan', defaultJobOptions: DEFAULT_JOB_OPTIONS, concurrency: 2 },
  discoveryFetch: {
    name: 'discovery-fetch',
    defaultJobOptions: {
      ...DEFAULT_JOB_OPTIONS,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2_000 },
    },
    concurrency: 4,
  },
  discoveryIngest: { name: 'discovery-ingest', defaultJobOptions: DEFAULT_JOB_OPTIONS, concurrency: 4 },
  /**
   * Enrichment (BF-027): run starts and the nightly refresh, and the steps themselves. Step retries are the
   * engine's (per step, with backoff, recorded on the step row); BullMQ's only cover infrastructure failures.
   */
  enrichmentRun: { name: 'enrichment-run', defaultJobOptions: DEFAULT_JOB_OPTIONS, concurrency: 4 },
  enrichmentStep: { name: 'enrichment-step', defaultJobOptions: DEFAULT_JOB_OPTIONS, concurrency: 8 },
  /** The nightly refresh: one job per UTC day. */
  enrichmentRefresh: { name: 'enrichment-refresh', defaultJobOptions: DEFAULT_JOB_OPTIONS, concurrency: 1 },
  /** Listing search (BF-022): business embeddings, re-computed when their text or the model changes. */
  search: {
    name: 'search',
    defaultJobOptions: {
      ...DEFAULT_JOB_OPTIONS,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2_000 },
    },
    concurrency: 4,
  },
  /** Scoring (BF-031): scores of a few businesses after a change. */
  scoring: { name: 'scoring', defaultJobOptions: DEFAULT_JOB_OPTIONS, concurrency: 4 },
  /** Bulk recomputes of a profile version for a workspace (long: one or two at a time). */
  scoringRecompute: { name: 'scoring-recompute', defaultJobOptions: DEFAULT_JOB_OPTIONS, concurrency: 2 },
  /**
   * Sites (BF-035): renderer revalidation after a publication changed (more attempts: the renderer may be
   * restarting), and the hourly preview expiry (one job per hour).
   */
  sitesRevalidate: {
    name: 'sites-revalidate',
    defaultJobOptions: {
      ...DEFAULT_JOB_OPTIONS,
      attempts: 6,
      backoff: { type: 'exponential', delay: 2_000 },
    },
    concurrency: 4,
  },
  sitesExpire: { name: 'sites-expire', defaultJobOptions: DEFAULT_JOB_OPTIONS, concurrency: 1 },
  /** Image processing of uploaded site assets (sharp: CPU-bound, a few at a time). */
  sitesAssetProcess: { name: 'sites-asset-process', defaultJobOptions: DEFAULT_JOB_OPTIONS, concurrency: 2 },
  /** A site's images collected from the business's website and the wordmark (BF-038; downloads through intel). */
  sitesAssetCollect: { name: 'sites-asset-collect', defaultJobOptions: DEFAULT_JOB_OPTIONS, concurrency: 2 },
  /** AI image generation (one provider call per job, a few images). */
  /** Site generation (BF-039): one queue per engine; worker concurrency is the engine's deployment-wide maximum. */
  generationBlocks: { name: 'generation-blocks', defaultJobOptions: GENERATION_JOB_OPTIONS, concurrency: 4 },
  generationClaudeAgentSdk: {
    name: 'generation-claude-agent-sdk',
    defaultJobOptions: GENERATION_JOB_OPTIONS,
    concurrency: 2,
  },
  generationClaudeCode: {
    name: 'generation-claude-code',
    defaultJobOptions: GENERATION_JOB_OPTIONS,
    concurrency: 2,
  },
  generationCodex: { name: 'generation-codex', defaultJobOptions: GENERATION_JOB_OPTIONS, concurrency: 2 },
  generationFake: { name: 'generation-fake', defaultJobOptions: GENERATION_JOB_OPTIONS, concurrency: 4 },
  /** The quality gates of a finished attempt, then the hand-off to the sites module. */
  generationQuality: { name: 'generation-quality', defaultJobOptions: DEFAULT_JOB_OPTIONS, concurrency: 4 },
  /** Every minute: attempts whose worker died are failed and retried. */
  generationReaper: { name: 'generation-reaper', defaultJobOptions: DEFAULT_JOB_OPTIONS, concurrency: 1 },
  sitesAssetGenerate: {
    name: 'sites-asset-generate',
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
    concurrency: 2,
  },
  /** Vision analysis of a processed image (tags, alt texts; one model call each). */
  sitesAssetAnalyze: { name: 'sites-asset-analyze', defaultJobOptions: DEFAULT_JOB_OPTIONS, concurrency: 4 },
  /** Thumbnails of published sites (services/intel takes the pictures). */
  sitesScreenshot: { name: 'sites-screenshot', defaultJobOptions: DEFAULT_JOB_OPTIONS, concurrency: 2 },
  /** Views flush (Valkey → site_view_daily) and the hourly `site.viewed` events, every 5 minutes. */
  sitesViews: { name: 'sites-views', defaultJobOptions: DEFAULT_JOB_OPTIONS, concurrency: 1 },
  /**
   * Outbound email (BF-052): the minute tick claims due messages; one send job per claimed message. Attempts are
   * the pipeline's (reconciled before any resend), never BullMQ's.
   */
  /** Bulk runs: one job per business (compliance, then an AI or template draft): a few at a time. */
  outreachBulk: { name: 'outreach-bulk', defaultJobOptions: DEFAULT_JOB_OPTIONS, concurrency: 2 },
  outreachTick: { name: 'outreach-tick', defaultJobOptions: DEFAULT_JOB_OPTIONS, concurrency: 1 },
  outreachSend: { name: 'outreach-send', defaultJobOptions: SINGLE_ATTEMPT_JOB_OPTIONS, concurrency: 4 },
} as const satisfies Record<string, QueueDefinition>;

export type QueueName = keyof typeof QUEUES;
export const QUEUE_NAMES = Object.keys(QUEUES) as QueueName[];
