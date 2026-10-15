import type { Clock } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { LOGGER } from '../../platform/logging/logger.ts';
import { MAX_TASK_ATTEMPTS, RunOrchestrator } from '../application/run-orchestrator.ts';
import {
  DISCOVERY_RUN_REPOSITORY,
  type DiscoveryRunRepository,
  RUN_QUEUE,
  type RunQueue,
} from '../application/run-ports.ts';

const INTERVAL_MS = 30_000;
/** A running task whose heartbeat is older than this lost its worker. */
export const STALE_AFTER_MS = 2 * 60_000;
const BATCH = 200;

export const RECONCILER_AUTOSTART = Symbol('DiscoveryReconcilerAutostart');

/**
 * Rebuilds execution from database state (ADR-0006): requeues tasks whose worker died, re-enqueues tasks whose
 * jobs were lost, re-runs ingestion that never happened, re-plans queued runs and finalizes finished ones.
 */
@Injectable()
export class RunReconciler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DISCOVERY_RUN_REPOSITORY) private readonly runs: DiscoveryRunRepository,
    @Inject(RUN_QUEUE) private readonly queue: RunQueue,
    private readonly orchestrator: RunOrchestrator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(RECONCILER_AUTOSTART) private readonly autostart: boolean,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.autostart) return;
    this.timer = setInterval(() => {
      this.reconcile().catch((error: unknown) =>
        this.logger.error({ err: error }, 'discovery reconcile failed'),
      );
    }, INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  async reconcile(): Promise<{
    requeued: number;
    failed: number;
    reenqueued: number;
    reingested: number;
    finalized: number;
    replanned: number;
  }> {
    const now = this.clock.now().getTime();
    const stale = new Date(now - STALE_AFTER_MS);
    // Fresh job ids per reconcile window: a job that failed for good keeps its id in BullMQ's failed set.
    const attemptKey = `r${Math.floor(now / 60_000)}`;
    let requeued = 0;
    let failed = 0;
    for (const task of await this.runs.staleRunningTasks(stale, BATCH)) {
      const run = await this.runs.getRun(task.runId);
      if (!run) continue;
      if (task.attempt >= MAX_TASK_ATTEMPTS) {
        await this.runs.failTask(task, 'worker lost');
        failed++;
        continue;
      }
      await this.runs.requeueTask(task.id);
      await this.queue.fetch(task, run.organizationId, 0, attemptKey);
      requeued++;
    }
    let reenqueued = 0;
    for (const task of await this.runs.queuedTasksOlderThan(stale, BATCH)) {
      const run = await this.runs.getRun(task.runId);
      if (!run) continue;
      // A duplicate job is harmless: only one claim of a queued task succeeds.
      await this.queue.fetch(task, run.organizationId, 0, attemptKey);
      reenqueued++;
    }
    let reingested = 0;
    for (const task of await this.runs.tasksAwaitingIngest(stale, BATCH)) {
      const run = await this.runs.getRun(task.runId);
      if (!run) continue;
      await this.queue.ingest(task.runId, task.id, run.organizationId, attemptKey);
      reingested++;
    }
    let replanned = 0;
    for (const runId of await this.runs.unplannedRunsOlderThan(stale, BATCH)) {
      const run = await this.runs.getRun(runId);
      if (!run) continue;
      // Re-planning is idempotent (dedupe keys); a running run resumes where its planning stopped.
      await this.queue.plan(runId, run.organizationId, attemptKey);
      replanned++;
    }
    let finalized = 0;
    for (const runId of await this.runs.runningRunsWithoutOpenWork(BATCH)) {
      if (await this.orchestrator.finalizeIfDone(runId)) finalized++;
    }
    const summary = { requeued, failed, reenqueued, reingested, finalized, replanned };
    if (Object.values(summary).some((n) => n > 0)) this.logger.info(summary, 'discovery reconciled');
    return summary;
  }
}
