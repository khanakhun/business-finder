import type { DefaultJobOptions } from 'bullmq';

/** Defaults for every queue: retries with exponential backoff, bounded history (ADR-0006). */
export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

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
} as const satisfies Record<string, QueueDefinition>;

export type QueueName = keyof typeof QUEUES;
export const QUEUE_NAMES = Object.keys(QUEUES) as QueueName[];
