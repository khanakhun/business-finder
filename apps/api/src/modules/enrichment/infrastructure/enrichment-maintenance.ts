import type { ApiEnv } from '@bf/config';
import type { Clock } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { APP_ENV, type AppEnv } from '../../platform/config/app-env.ts';
import { LOGGER } from '../../platform/logging/logger.ts';
import {
  ENRICHMENT_QUEUE,
  ENRICHMENT_REPOSITORY,
  type EnrichmentQueue,
  type EnrichmentRepository,
} from '../application/ports.ts';
import { EnrichmentOrchestrator, MAX_STEP_ATTEMPTS } from '../application/run-orchestrator.ts';

const INTERVAL_MS = 30_000;
/** A running step whose heartbeat is older than this lost its worker (heartbeats every 15 s). */
export const STALE_AFTER_MS = 2 * 60_000;
const BATCH = 200;
const REFRESH_CHECK_MS = 10 * 60_000;

export const MAINTENANCE_AUTOSTART = Symbol('EnrichmentMaintenanceAutostart');

/**
 * Rebuilds execution from database state (ADR-0006): steps whose worker died go back to the queue (or fail after
 * their last attempt), queued steps whose job was lost are enqueued again, idle runs are advanced (which also
 * finalizes runs whose steps are all done). Worker process only.
 */
@Injectable()
export class EnrichmentReconciler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(ENRICHMENT_REPOSITORY) private readonly runs: EnrichmentRepository,
    @Inject(ENRICHMENT_QUEUE) private readonly queue: EnrichmentQueue,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(MAINTENANCE_AUTOSTART) private readonly autostart: boolean,
    private readonly orchestrator: EnrichmentOrchestrator,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.autostart) return;
    this.timer = setInterval(() => {
      this.reconcile().catch((error: unknown) =>
        this.logger.error({ err: error }, 'enrichment reconcile failed'),
      );
    }, INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  async reconcile(): Promise<{ requeued: number; failed: number; reenqueued: number; advanced: number }> {
    const now = this.clock.now();
    const stale = new Date(now.getTime() - STALE_AFTER_MS);
    // Fresh job ids per window: a job that failed for good keeps its id in BullMQ's failed set.
    const retryKey = `r${Math.floor(now.getTime() / 60_000)}`;
    let requeued = 0;
    let failed = 0;
    const touched = new Set<string>();
    for (const step of await this.runs.staleRunningSteps(stale, BATCH)) {
      const run = await this.runs.findRun(step.runId);
      if (!run) continue;
      if (step.attempt >= MAX_STEP_ATTEMPTS) {
        if (await this.orchestrator.failLostStep(run, step)) {
          failed++;
          touched.add(run.id);
        }
        continue;
      }
      const released = await this.runs.releaseStep(step.id, 'Worker lost; retrying', now);
      if (released) {
        await this.queue.step(released, run.organizationId, run.trigger, { retryKey });
        requeued++;
      }
    }
    let reenqueued = 0;
    for (const step of await this.runs.idleQueuedSteps(stale, BATCH)) {
      const run = await this.runs.findRun(step.runId);
      if (!run) continue;
      // A duplicate job is harmless: only one claim of a queued step succeeds.
      await this.queue.step(step, run.organizationId, run.trigger, { retryKey });
      reenqueued++;
    }
    let advanced = 0;
    for (const run of await this.runs.idleOpenRuns(stale, BATCH)) touched.add(run.id);
    for (const runId of touched) {
      const run = await this.runs.findRun(runId);
      if (!run) continue;
      if (run.status === 'queued') await this.queue.start(runId, run.organizationId, run.trigger, retryKey);
      else await this.orchestrator.advance(runId);
      advanced++;
    }
    const summary = { requeued, failed, reenqueued, advanced };
    if (Object.values(summary).some((n) => n > 0)) this.logger.info(summary, 'enrichment reconciled');
    return summary;
  }
}

/**
 * Enqueues the nightly refresh once per UTC day, during the configured hour (the job id is per day: workers
 * checking at the same time enqueue one job).
 */
@Injectable()
export class EnrichmentScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private readonly hour: number;

  constructor(
    @Inject(ENRICHMENT_QUEUE) private readonly queue: EnrichmentQueue,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(APP_ENV) env: AppEnv,
    @Inject(MAINTENANCE_AUTOSTART) private readonly autostart: boolean,
  ) {
    this.hour = (env as ApiEnv).ENRICHMENT_REFRESH_HOUR_UTC;
  }

  onApplicationBootstrap(): void {
    if (!this.autostart) return;
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) =>
        this.logger.error({ err: error }, 'enrichment scheduling failed'),
      );
    }, REFRESH_CHECK_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /**
   * Enqueues today's refresh once the refresh hour has come (a worker down at that hour catches up later in the
   * day; the job id is per day, so this is one job); returns whether it asked.
   */
  async tick(): Promise<boolean> {
    const now = this.clock.now();
    if (now.getUTCHours() < this.hour) return false;
    await this.queue.refresh(now.toISOString().slice(0, 10));
    return true;
  }
}
