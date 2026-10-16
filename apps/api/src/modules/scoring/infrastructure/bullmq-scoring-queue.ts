import { ScoringComputeJob, ScoringRecomputeJob } from '@bf/contracts';
import { QUEUES, TypedProducer } from '@bf/queue';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { ScoringQueue } from '../application/ports.ts';

@Injectable()
export class BullmqScoringQueue implements ScoringQueue {
  private readonly computeJobs: TypedProducer<typeof ScoringComputeJob>;
  private readonly recomputeJobs: TypedProducer<typeof ScoringRecomputeJob>;

  constructor(
    @InjectQueue(QUEUES.scoring.name) computeQueue: Queue,
    @InjectQueue(QUEUES.scoringRecompute.name) recomputeQueue: Queue,
  ) {
    this.computeJobs = new TypedProducer(computeQueue, ScoringComputeJob);
    this.recomputeJobs = new TypedProducer(recomputeQueue, ScoringRecomputeJob);
  }

  async compute(input: Parameters<ScoringQueue['compute']>[0]): Promise<void> {
    // Large fan-outs (a business tracked by many workspaces is one id each; a page is ≤ 1,000 ids).
    for (let start = 0; start < input.businessIds.length; start += 1_000) {
      await this.computeJobs.add({
        orgId: input.organizationId,
        idempotencyKey: start === 0 ? input.idempotencyKey : `${input.idempotencyKey}:${start}`,
        businessIds: input.businessIds.slice(start, start + 1_000),
        ...(input.profileIds ? { profileIds: [...input.profileIds] } : {}),
      });
    }
  }

  async recompute(input: Parameters<ScoringQueue['recompute']>[0]): Promise<void> {
    await this.recomputeJobs.add({
      orgId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      profileId: input.profileId,
      version: input.version,
      ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
    });
  }
}

/** OpenAPI generation boots without Valkey: nothing is enqueued there. */
export const OPENAPI_SCORING_QUEUE: ScoringQueue = {
  compute: async () => {},
  recompute: async () => {},
};
