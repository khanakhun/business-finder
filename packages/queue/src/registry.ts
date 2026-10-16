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
} as const satisfies Record<string, QueueDefinition>;

export type QueueName = keyof typeof QUEUES;
export const QUEUE_NAMES = Object.keys(QUEUES) as QueueName[];
