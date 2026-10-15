import { TaxonomyEmbedCategoriesJob } from '@bf/contracts';
import { type JobContext, QUEUES } from '@bf/queue';
import { Processor } from '@nestjs/bullmq';
import type { z } from 'zod';
import { TypedProcessor } from '../../../platform/queue/typed-processor.ts';
import {
  CategoryEmbedder,
  type EmbedCategoriesResult,
} from '../../application/taxonomy/category-embedder.ts';

@Processor(QUEUES.taxonomy.name, { concurrency: QUEUES.taxonomy.concurrency })
export class TaxonomyEmbedProcessor extends TypedProcessor<
  typeof TaxonomyEmbedCategoriesJob,
  EmbedCategoriesResult
> {
  protected readonly definition = TaxonomyEmbedCategoriesJob;

  constructor(private readonly embedder: CategoryEmbedder) {
    super();
  }

  async handle(
    payload: z.output<typeof TaxonomyEmbedCategoriesJob.schema>,
    context: JobContext,
  ): Promise<EmbedCategoriesResult> {
    const result = await this.embedder.embedPending();
    context.logger.info({ reason: payload.reason, ...result }, 'taxonomy embeddings run');
    return result;
  }
}
