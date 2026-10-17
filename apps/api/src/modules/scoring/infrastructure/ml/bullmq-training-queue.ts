import { ScoringMlTrainJob } from '@bf/contracts';
import { QUEUES, TypedProducer } from '@bf/queue';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { TrainingQueue } from '../../application/ml/ports.ts';

@Injectable()
export class BullmqTrainingQueue implements TrainingQueue {
  private readonly jobs: TypedProducer<typeof ScoringMlTrainJob>;

  constructor(@InjectQueue(QUEUES.scoringMlTrain.name) queue: Queue) {
    this.jobs = new TypedProducer(queue, ScoringMlTrainJob);
  }

  async enqueue(organizationId: string, runId: string): Promise<void> {
    await this.jobs.add({ orgId: organizationId, runId, idempotencyKey: `ml-train:${runId}` });
  }
}
