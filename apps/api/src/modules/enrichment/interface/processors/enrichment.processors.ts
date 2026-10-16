import { EnrichmentRefreshJob, EnrichmentRunJob, EnrichmentStepJob } from '@bf/contracts';
import { type JobContext, QUEUES } from '@bf/queue';
import { Processor } from '@nestjs/bullmq';
import type { z } from 'zod';
import { TypedProcessor } from '../../../platform/queue/typed-processor.ts';
import { NightlyRefresh } from '../../application/enrichment.triggers.ts';
import { EnrichmentOrchestrator } from '../../application/run-orchestrator.ts';

@Processor(QUEUES.enrichmentRun.name, { concurrency: QUEUES.enrichmentRun.concurrency })
export class EnrichmentRunProcessor extends TypedProcessor<typeof EnrichmentRunJob, void> {
  protected readonly definition = EnrichmentRunJob;

  constructor(private readonly orchestrator: EnrichmentOrchestrator) {
    super();
  }

  handle(payload: z.output<typeof EnrichmentRunJob.schema>): Promise<void> {
    return this.orchestrator.start(payload.runId);
  }
}

@Processor(QUEUES.enrichmentStep.name, { concurrency: QUEUES.enrichmentStep.concurrency })
export class EnrichmentStepProcessor extends TypedProcessor<typeof EnrichmentStepJob, void> {
  protected readonly definition = EnrichmentStepJob;

  constructor(private readonly orchestrator: EnrichmentOrchestrator) {
    super();
  }

  handle(payload: z.output<typeof EnrichmentStepJob.schema>, context: JobContext): Promise<void> {
    return this.orchestrator.executeStep(payload.runId, payload.stepRowId, context.signal, context.jobId);
  }
}

@Processor(QUEUES.enrichmentRefresh.name, { concurrency: QUEUES.enrichmentRefresh.concurrency })
export class EnrichmentRefreshProcessor extends TypedProcessor<typeof EnrichmentRefreshJob, void> {
  protected readonly definition = EnrichmentRefreshJob;

  constructor(private readonly refresh: NightlyRefresh) {
    super();
  }

  async handle(payload: z.output<typeof EnrichmentRefreshJob.schema>): Promise<void> {
    await this.refresh.run(payload.day);
  }
}
