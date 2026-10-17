import { ScoringMlTrainJob } from '@bf/contracts';
import { type JobContext, QUEUES } from '@bf/queue';
import { Processor } from '@nestjs/bullmq';
import type { z } from 'zod';
import { TypedProcessor } from '../../../platform/queue/typed-processor.ts';
import { ModelTrainer } from '../../application/ml/model-trainer.ts';

/** Outcome-model training runs (BF-059): one at a time; the run records success or failure itself. */
@Processor(QUEUES.scoringMlTrain.name, { concurrency: QUEUES.scoringMlTrain.concurrency })
export class ScoringMlTrainProcessor extends TypedProcessor<typeof ScoringMlTrainJob, void> {
  protected readonly definition = ScoringMlTrainJob;

  constructor(private readonly trainer: ModelTrainer) {
    super();
  }

  async handle(payload: z.output<typeof ScoringMlTrainJob.schema>, context: JobContext): Promise<void> {
    await this.trainer.run(payload.runId);
    context.logger.info({ runId: payload.runId }, 'training run finished');
  }
}
