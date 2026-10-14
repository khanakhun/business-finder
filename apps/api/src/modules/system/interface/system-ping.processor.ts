import { SystemPingJob } from '@bf/contracts';
import { metrics } from '@bf/observability';
import { type JobContext, QUEUES } from '@bf/queue';
import { Processor } from '@nestjs/bullmq';
import type { z } from 'zod';
import { TypedProcessor } from '../../platform/queue/typed-processor.ts';

const pings = () => metrics.counter({ name: 'bf_system_pings_total', help: 'system.ping jobs handled' });

/** Worker side of the reference job: delegates nothing (no use case needed for a log line + metric). */
@Processor(QUEUES.system.name, { concurrency: QUEUES.system.concurrency })
export class SystemPingProcessor extends TypedProcessor<typeof SystemPingJob, { pong: number }> {
  protected readonly definition = SystemPingJob;

  async handle(
    payload: z.output<typeof SystemPingJob.schema>,
    context: JobContext,
  ): Promise<{ pong: number }> {
    pings().inc();
    context.logger.info({ sequence: payload.sequence }, 'pong');
    return { pong: payload.sequence };
  }
}
