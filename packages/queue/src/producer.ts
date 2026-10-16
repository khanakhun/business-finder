import type { JobDefinition, JobPayloadBase } from '@bf/contracts';
import { injectTraceContext } from '@bf/observability';
import type { JobsOptions, Queue } from 'bullmq';
import type { z } from 'zod';
import { jobIdFor } from './keys.ts';

/** Payload callers provide: the job's fields without trace context, which the producer adds. */
export type ProducerInput<D extends JobDefinition<string, string, z.ZodRawShape>> = Omit<
  z.input<D['schema']>,
  'traceparent'
>;

/**
 * Enqueues validated jobs of one definition. Adds the active trace context (so the worker continues the trace) and
 * derives the BullMQ job id from the idempotency key, so duplicates collapse while the first job exists.
 */
export class TypedProducer<D extends JobDefinition<string, string, z.ZodRawShape>> {
  constructor(
    private readonly queue: Queue,
    private readonly definition: D,
  ) {
    if (queue.name !== definition.queue) {
      throw new Error(`Job ${definition.queue}/${definition.name} cannot be added to queue "${queue.name}"`);
    }
  }

  async add(input: ProducerInput<D>, options: Omit<JobsOptions, 'jobId'> = {}): Promise<string> {
    const payload = this.definition.schema.parse({ ...input, ...injectTraceContext() });
    // Safe: defineJob() builds every job schema by extending JobPayloadBase.
    const jobId = jobIdFor(this.definition.name, (payload as JobPayloadBase).idempotencyKey);
    const job = await this.queue.add(this.definition.name, payload, { ...options, jobId });
    if (!job.id) throw new Error('BullMQ returned a job without id');
    return job.id;
  }
}
