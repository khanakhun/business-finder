import { DiscoveryFetchJob, DiscoveryIngestJob, DiscoveryPlanJob } from '@bf/contracts';
import { jobIdFor, QUEUES, requestCancellation, TypedProducer } from '@bf/queue';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { VALKEY } from '../../platform/valkey/valkey.module.ts';
import type { RunQueue, TaskRecord } from '../application/run-ports.ts';

/** Fetch jobs are keyed by task and attempt: a reconciler retry after a crash gets a fresh job. */
export const fetchKey = (task: Pick<TaskRecord, 'id' | 'attempt'>) => `${task.id}:${task.attempt}`;

@Injectable()
export class BullmqRunQueue implements RunQueue {
  private readonly planner: TypedProducer<typeof DiscoveryPlanJob>;
  private readonly fetcher: TypedProducer<typeof DiscoveryFetchJob>;
  private readonly ingester: TypedProducer<typeof DiscoveryIngestJob>;

  constructor(
    @InjectQueue(QUEUES.discoveryPlan.name) plan: Queue,
    @InjectQueue(QUEUES.discoveryFetch.name) fetch: Queue,
    @InjectQueue(QUEUES.discoveryIngest.name) ingest: Queue,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {
    this.planner = new TypedProducer(plan, DiscoveryPlanJob);
    this.fetcher = new TypedProducer(fetch, DiscoveryFetchJob);
    this.ingester = new TypedProducer(ingest, DiscoveryIngestJob);
  }

  async plan(runId: string, organizationId: string, attemptKey = '0'): Promise<void> {
    await this.planner.add({ runId, orgId: organizationId, idempotencyKey: `${runId}:${attemptKey}` });
  }

  async fetch(task: TaskRecord, organizationId: string, delayMs = 0, attemptKey?: string): Promise<void> {
    const idempotencyKey = attemptKey ? `${fetchKey(task)}:${attemptKey}` : fetchKey(task);
    await this.fetcher.add(
      { runId: task.runId, taskId: task.id, orgId: organizationId, idempotencyKey },
      delayMs > 0 ? { delay: delayMs } : {},
    );
  }

  async ingest(runId: string, taskId: string, organizationId: string, attemptKey = '0'): Promise<void> {
    await this.ingester.add({
      runId,
      taskId,
      orgId: organizationId,
      idempotencyKey: `${taskId}:${attemptKey}`,
    });
  }

  async cancelFetches(tasks: readonly TaskRecord[]): Promise<void> {
    // The job of a running task was enqueued with one of its earlier attempt numbers (claims add one; BullMQ
    // retries keep the job id), so every candidate id is flagged. Reconciler jobs are not reached: their
    // results are discarded anyway, because a cancelled run accepts no completed task.
    await Promise.all(
      tasks.flatMap((task) =>
        Array.from({ length: task.attempt }, (_, attempt) =>
          requestCancellation(
            this.valkey,
            QUEUES.discoveryFetch.name,
            jobIdFor(DiscoveryFetchJob.name, fetchKey({ id: task.id, attempt })),
          ),
        ),
      ),
    );
  }
}
