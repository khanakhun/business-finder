import { SearchEmbedBusinessJob } from '@bf/contracts';
import { type JobContext, QUEUES } from '@bf/queue';
import { Processor } from '@nestjs/bullmq';
import type { z } from 'zod';
import { TypedProcessor } from '../../../platform/queue/typed-processor.ts';
import { BusinessEmbedder, type EmbedReport } from '../../application/business-embedder.ts';

@Processor(QUEUES.search.name, { concurrency: QUEUES.search.concurrency })
export class EmbedBusinessProcessor extends TypedProcessor<typeof SearchEmbedBusinessJob, EmbedReport> {
  protected readonly definition = SearchEmbedBusinessJob;

  constructor(private readonly embedder: BusinessEmbedder) {
    super();
  }

  async handle(
    payload: z.output<typeof SearchEmbedBusinessJob.schema>,
    context: JobContext,
  ): Promise<EmbedReport> {
    const report = await this.embedder.embed([payload.businessId]);
    context.logger.debug({ businessId: payload.businessId, ...report }, 'business embedding');
    return report;
  }
}
