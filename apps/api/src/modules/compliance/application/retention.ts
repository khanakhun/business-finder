import type { Clock, RetentionPolicyView, RetentionRun } from '@bf/contracts';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { LOGGER, type Logger } from '../../platform/logging/logger.ts';
import { RETENTION_RUNS, type RetentionRunRepository } from './ports.ts';

// The retention engine (BF-055): modules register data-driven policies (what, how long, delete/anonymize/truncate);
// the worker runs them daily in batches (≤ 1,000 rows per transaction, repeated until done, safe to resume), and
// anyone with `compliance:manage` can ask for a dry run (counts only). Every run is recorded with per-policy counts.

export interface RetentionPolicy extends RetentionPolicyView {
  /** Rows the policy would act on now. */
  count(now: Date): Promise<number>;
  /** Acts on at most `limit` rows; returns how many. */
  apply(now: Date, limit: number): Promise<number>;
}

const BATCH = 1_000;
const MAX_BATCHES = 1_000;
const EVERY_MS = 24 * 3_600_000;

@Injectable()
export class RetentionRegistry {
  private readonly policies = new Map<string, RetentionPolicy>();

  register(policy: RetentionPolicy): void {
    if (!this.policies.has(policy.id)) this.policies.set(policy.id, policy);
  }

  list(): RetentionPolicy[] {
    return [...this.policies.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

@Injectable()
export class RetentionRunner {
  constructor(
    private readonly registry: RetentionRegistry,
    @Inject(RETENTION_RUNS) private readonly runs: RetentionRunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  overview() {
    return this.runs.recent(20).then((runs) => ({
      policies: this.registry.list().map(({ id, entity, description, retentionDays, action }) => ({
        id,
        entity,
        description,
        retentionDays,
        action,
      })),
      runs,
    }));
  }

  async run(dryRun: boolean, triggeredBy: string | null, startedRunId?: string): Promise<RetentionRun> {
    const now = this.clock.now();
    const runId = startedRunId ?? (await this.runs.start(dryRun, triggeredBy));
    const results: RetentionRun['results'] = [];
    for (const policy of this.registry.list()) {
      const started = performance.now();
      try {
        let count = 0;
        if (dryRun) count = await policy.count(now);
        else
          for (let batch = 0; batch < MAX_BATCHES; batch++) {
            const done = await policy.apply(now, BATCH);
            count += done;
            if (done < BATCH) break;
          }
        results.push({
          policy: policy.id,
          count,
          durationMs: Math.round(performance.now() - started),
          error: null,
        });
      } catch (error) {
        this.logger.warn({ err: error, policy: policy.id }, 'retention policy failed');
        results.push({
          policy: policy.id,
          count: 0,
          durationMs: Math.round(performance.now() - started),
          error: error instanceof Error ? error.message.slice(0, 300) : 'failed',
        });
      }
    }
    return this.runs.finish(runId, results);
  }
}

/** The daily run (worker only); one process at a time (database advisory lock). */
@Injectable()
export class RetentionSchedule implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly runner: RetentionRunner,
    @Inject(RETENTION_RUNS) private readonly runs: RetentionRunRepository,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), EVERY_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    try {
      const runId = await this.runs.claimDailyRun();
      if (!runId) return;
      const run = await this.runner.run(false, null, runId);
      this.logger.info({ runId: run.id, results: run.results }, 'retention run done');
    } catch (err) {
      this.logger.warn({ err }, 'retention run failed');
    }
  }
}
