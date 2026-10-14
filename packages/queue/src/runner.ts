import type { JobDefinition, JobPayloadBase } from '@bf/contracts';
import { type Logger, metrics, runWithExtractedContext, withLogContext } from '@bf/observability';
import { type Job, UnrecoverableError } from 'bullmq';
import type { Redis } from 'ioredis';
import type { z } from 'zod';
import { JobCancelledError, watchCancellation } from './cancellation.ts';
import { IdempotencyGuard } from './idempotency.ts';
import { keys } from './keys.ts';

export interface JobContext {
  readonly jobId: string;
  readonly attempt: number;
  /** Aborted when the job is cancelled (any process) or the worker shuts down. Pass it to long operations. */
  readonly signal: AbortSignal;
  progress(value: number | Record<string, unknown>): Promise<void>;
  readonly logger: Logger;
}

export type JobHandler<D extends JobDefinition<string, string, z.ZodRawShape>, R> = (
  payload: z.output<D['schema']>,
  context: JobContext,
) => Promise<R>;

export interface RunnerDeps {
  readonly valkey: Redis;
  readonly logger: Logger;
  readonly cancelPollMs?: number;
  readonly idempotency?: IdempotencyGuard;
}

/** Raised when another delivery of the same idempotency key is still running; BullMQ retries it later. */
export class DuplicateRunningError extends Error {
  constructor(key: string) {
    super(`Another run of ${key} is in progress`);
    this.name = 'DuplicateRunningError';
  }
}

export type JobOutcome<R> =
  | { readonly status: 'processed'; readonly result: R }
  | { readonly status: 'skipped' };

const outcomes = () =>
  metrics.counter({
    name: 'bf_jobs_processed_total',
    help: 'Jobs handled by outcome',
    labelNames: ['queue', 'job', 'outcome'],
  });
const durations = () =>
  metrics.histogram({
    name: 'bf_job_duration_seconds',
    help: 'Job handler duration',
    labelNames: ['queue', 'job'],
  });

/**
 * Template for every job: validate → idempotency claim → continue the producer's trace → log context →
 * cancellable handler → metrics. Invalid payloads fail without retries.
 */
export function createJobRunner<D extends JobDefinition<string, string, z.ZodRawShape>, R>(
  definition: D,
  handler: JobHandler<D, R>,
  deps: RunnerDeps,
): (job: Job, token?: string, workerSignal?: AbortSignal) => Promise<JobOutcome<R>> {
  const guard = deps.idempotency ?? new IdempotencyGuard(deps.valkey);
  const labels = { queue: definition.queue, job: definition.name };

  return async (job, _token, workerSignal) => {
    const parsed = definition.schema.safeParse(job.data);
    if (!parsed.success) {
      outcomes().inc({ ...labels, outcome: 'invalid' });
      throw new UnrecoverableError(
        `Invalid ${definition.queue}/${definition.name} payload: ${parsed.error.message}`,
      );
    }
    const payload = parsed.data as z.output<D['schema']>;
    // Safe: defineJob() builds every job schema by extending JobPayloadBase.
    const base = parsed.data as JobPayloadBase;
    const jobId = job.id ?? 'unknown';
    const idemKey = keys.idempotency(definition.queue, definition.name, base.idempotencyKey);
    const logger = deps.logger.child({ jobId, queue: definition.queue, job: definition.name });

    const claim = await guard.acquire(idemKey);
    if (claim === 'done') {
      outcomes().inc({ ...labels, outcome: 'skipped' });
      logger.info({ idempotencyKey: base.idempotencyKey }, 'job already processed, skipping');
      return { status: 'skipped' };
    }
    if (claim === 'running') throw new DuplicateRunningError(base.idempotencyKey);

    const carrier = base.traceparent ? { traceparent: base.traceparent } : undefined;
    return runWithExtractedContext(carrier, `job.process ${definition.queue}`, () =>
      withLogContext(
        { jobId, queue: definition.queue, ...(base.orgId ? { orgId: base.orgId } : {}) },
        async () => {
          const cancellation = watchCancellation(deps.valkey, definition.queue, jobId, deps.cancelPollMs);
          const signal = workerSignal
            ? AbortSignal.any([cancellation.signal, workerSignal])
            : cancellation.signal;
          const started = performance.now();
          try {
            const result = await handler(payload, {
              jobId,
              attempt: job.attemptsMade + 1,
              signal,
              progress: (value) => job.updateProgress(value),
              logger,
            });
            await guard.complete(idemKey);
            outcomes().inc({ ...labels, outcome: 'completed' });
            return { status: 'processed', result };
          } catch (error) {
            await guard.release(idemKey);
            const cancelled = signal.aborted && signal.reason instanceof JobCancelledError;
            outcomes().inc({ ...labels, outcome: cancelled ? 'cancelled' : 'failed' });
            logger.warn(
              { err: error, attempt: job.attemptsMade + 1 },
              cancelled ? 'job cancelled' : 'job failed',
            );
            // A cancelled job must not be retried.
            if (cancelled) throw new UnrecoverableError((signal.reason as Error).message);
            throw error;
          } finally {
            cancellation.stop();
            durations().observe(labels, (performance.now() - started) / 1000);
          }
        },
      ),
    );
  };
}
