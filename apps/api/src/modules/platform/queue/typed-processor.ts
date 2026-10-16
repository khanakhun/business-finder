import type { JobDefinition } from '@bf/contracts';
import { createJobRunner, type JobContext, type JobOutcome } from '@bf/queue';
import { WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { z } from 'zod';
import { LOGGER, type Logger } from '../logging/logger.ts';
import { VALKEY } from '../valkey/valkey.module.ts';

/**
 * Base class for job processors (Template Method): `process()` validates the payload, enforces idempotency,
 * continues the producer's trace, sets log context, wires cancellation and records metrics; subclasses only
 * implement `handle()`. Register with `@Processor(QUEUES.<name>.name, { concurrency })`.
 */
export abstract class TypedProcessor<
  D extends JobDefinition<string, string, z.ZodRawShape>,
  R,
> extends WorkerHost {
  protected abstract readonly definition: D;

  @Inject(VALKEY) private readonly valkey!: Redis;
  @Inject(LOGGER) private readonly logger!: Logger;
  private runner: ReturnType<typeof createJobRunner<D, R>> | undefined;

  abstract handle(payload: z.output<D['schema']>, context: JobContext): Promise<R>;

  override async process(job: Job, token?: string, signal?: AbortSignal): Promise<JobOutcome<R>> {
    this.runner ??= createJobRunner(this.definition, (payload, context) => this.handle(payload, context), {
      valkey: this.valkey,
      logger: this.logger,
    });
    return this.runner(job, token, signal);
  }
}
