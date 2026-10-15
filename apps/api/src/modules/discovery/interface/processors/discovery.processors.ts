import { DiscoveryFetchJob, DiscoveryIngestJob, DiscoveryPlanJob } from '@bf/contracts';
import { type JobContext, QUEUES } from '@bf/queue';
import { Processor } from '@nestjs/bullmq';
import type { z } from 'zod';
import { TypedProcessor } from '../../../platform/queue/typed-processor.ts';
import { RunOrchestrator } from '../../application/run-orchestrator.ts';

@Processor(QUEUES.discoveryPlan.name, { concurrency: QUEUES.discoveryPlan.concurrency })
export class DiscoveryPlanProcessor extends TypedProcessor<typeof DiscoveryPlanJob, void> {
  protected readonly definition = DiscoveryPlanJob;

  constructor(private readonly orchestrator: RunOrchestrator) {
    super();
  }

  handle(payload: z.output<typeof DiscoveryPlanJob.schema>): Promise<void> {
    return this.orchestrator.plan(payload.runId);
  }
}

@Processor(QUEUES.discoveryFetch.name, { concurrency: QUEUES.discoveryFetch.concurrency })
export class DiscoveryFetchProcessor extends TypedProcessor<typeof DiscoveryFetchJob, void> {
  protected readonly definition = DiscoveryFetchJob;

  constructor(private readonly orchestrator: RunOrchestrator) {
    super();
  }

  handle(payload: z.output<typeof DiscoveryFetchJob.schema>, context: JobContext): Promise<void> {
    return this.orchestrator.fetch(payload.runId, payload.taskId, context.signal);
  }
}

@Processor(QUEUES.discoveryIngest.name, { concurrency: QUEUES.discoveryIngest.concurrency })
export class DiscoveryIngestProcessor extends TypedProcessor<typeof DiscoveryIngestJob, void> {
  protected readonly definition = DiscoveryIngestJob;

  constructor(private readonly orchestrator: RunOrchestrator) {
    super();
  }

  handle(payload: z.output<typeof DiscoveryIngestJob.schema>): Promise<void> {
    return this.orchestrator.ingest(payload.runId, payload.taskId);
  }
}
