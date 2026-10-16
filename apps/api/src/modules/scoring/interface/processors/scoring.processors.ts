import { ScoringComputeJob, ScoringRecomputeJob } from '@bf/contracts';
import { type JobContext, QUEUES } from '@bf/queue';
import { Processor } from '@nestjs/bullmq';
import type { z } from 'zod';
import { TypedProcessor } from '../../../platform/queue/typed-processor.ts';
import { type ComputeOutcome, ScoringService } from '../../application/scoring.service.ts';
import { RecomputeRunner } from '../../application/scoring.use-cases.ts';

@Processor(QUEUES.scoring.name, { concurrency: QUEUES.scoring.concurrency })
export class ScoringComputeProcessor extends TypedProcessor<typeof ScoringComputeJob, ComputeOutcome> {
  protected readonly definition = ScoringComputeJob;

  constructor(private readonly scoring: ScoringService) {
    super();
  }

  async handle(
    payload: z.output<typeof ScoringComputeJob.schema>,
    context: JobContext,
  ): Promise<ComputeOutcome> {
    if (!payload.orgId) return { scored: 0, written: 0, unchanged: 0 };
    const outcome = await this.scoring.compute(payload.orgId, payload.businessIds, {
      ...(payload.profileIds ? { profileIds: payload.profileIds } : {}),
    });
    context.logger.debug({ businesses: payload.businessIds.length, ...outcome }, 'scores computed');
    return outcome;
  }
}

@Processor(QUEUES.scoringRecompute.name, { concurrency: QUEUES.scoringRecompute.concurrency })
export class ScoringRecomputeProcessor extends TypedProcessor<
  typeof ScoringRecomputeJob,
  { readonly done: number; readonly written: number }
> {
  protected readonly definition = ScoringRecomputeJob;

  constructor(private readonly recompute: RecomputeRunner) {
    super();
  }

  async handle(payload: z.output<typeof ScoringRecomputeJob.schema>, context: JobContext) {
    if (!payload.orgId) return { done: 0, written: 0 };
    const outcome = await this.recompute.run(
      payload.orgId,
      payload.profileId,
      payload.version,
      context.signal,
    );
    context.logger.info(
      { profileId: payload.profileId, version: payload.version, ...outcome },
      'profile recomputed',
    );
    return outcome;
  }
}
