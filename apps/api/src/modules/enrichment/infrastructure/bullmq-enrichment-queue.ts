import {
  EnrichmentRefreshJob,
  EnrichmentRunJob,
  EnrichmentStepJob,
  type EnrichmentTrigger,
} from '@bf/contracts';
import { QUEUES, requestCancellation, TypedProducer } from '@bf/queue';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { VALKEY } from '../../platform/valkey/valkey.module.ts';
import type { EnrichmentQueue, StepRecord } from '../application/ports.ts';

/** BullMQ priorities (lower first): what a person is waiting for before batches. */
const PRIORITY: Record<EnrichmentTrigger, number> = {
  manual: 1,
  event: 5,
  discovery: 10,
  bulk: 20,
  schedule: 50,
};

/** Step jobs are keyed by step row and attempt: a retry (new attempt) is a new job; a repeat is the same one. */
export const stepKey = (step: Pick<StepRecord, 'id' | 'attempt'>) => `${step.id}:${step.attempt}`;

@Injectable()
export class BullmqEnrichmentQueue implements EnrichmentQueue {
  private readonly starter: TypedProducer<typeof EnrichmentRunJob>;
  private readonly refresher: TypedProducer<typeof EnrichmentRefreshJob>;
  private readonly stepper: TypedProducer<typeof EnrichmentStepJob>;

  constructor(
    @InjectQueue(QUEUES.enrichmentRun.name) run: Queue,
    @InjectQueue(QUEUES.enrichmentStep.name) step: Queue,
    @InjectQueue(QUEUES.enrichmentRefresh.name) refresh: Queue,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {
    this.starter = new TypedProducer(run, EnrichmentRunJob);
    this.refresher = new TypedProducer(refresh, EnrichmentRefreshJob);
    this.stepper = new TypedProducer(step, EnrichmentStepJob);
  }

  async start(
    runId: string,
    organizationId: string,
    trigger: EnrichmentTrigger,
    attemptKey = '0',
  ): Promise<void> {
    await this.starter.add(
      { runId, orgId: organizationId, idempotencyKey: `${runId}:${attemptKey}` },
      { priority: PRIORITY[trigger] },
    );
  }

  async step(
    step: Pick<StepRecord, 'id' | 'runId' | 'attempt'>,
    organizationId: string,
    trigger: EnrichmentTrigger,
    options: { readonly delayMs?: number; readonly retryKey?: string } = {},
  ): Promise<void> {
    const key = options.retryKey ? `${stepKey(step)}:${options.retryKey}` : stepKey(step);
    await this.stepper.add(
      { runId: step.runId, stepRowId: step.id, orgId: organizationId, idempotencyKey: key },
      {
        priority: PRIORITY[trigger],
        ...(options.delayMs && options.delayMs > 0 ? { delay: options.delayMs } : {}),
      },
    );
  }

  async cancel(steps: readonly Pick<StepRecord, 'id' | 'jobId'>[]): Promise<void> {
    // The job that claimed each step (recorded at claim): whichever key it was enqueued with.
    await Promise.all(
      steps.flatMap((step) =>
        step.jobId ? [requestCancellation(this.valkey, QUEUES.enrichmentStep.name, step.jobId)] : [],
      ),
    );
  }

  async refresh(day: string): Promise<void> {
    await this.refresher.add({ day, orgId: null, idempotencyKey: `refresh:${day}` });
  }
}
