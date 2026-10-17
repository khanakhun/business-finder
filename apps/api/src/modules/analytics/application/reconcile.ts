import type { Clock } from '@bf/contracts';
import { metrics } from '@bf/observability';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { LOGGER, type Logger } from '../../platform/logging/logger.ts';
import { FACTS_MAINTENANCE, type FactsMaintenance } from './ports.ts';

// Nightly reconciliation (BF-058, worker): once per UTC day, the facts' counts of sent emails, leads and finished
// jobs over the last week are compared with their source tables, per workspace. A drift over 1% is logged and
// raises `bf_analytics_reconcile_max_drift_ratio` (the alert in analytics.rules.yml); the backfill repairs it.

const EVERY_MS = 60 * 60_000;
const WATERMARK = 'reconcile';
export const DRIFT_THRESHOLD = 0.01;

const maxDrift = () =>
  metrics.gauge({
    name: 'bf_analytics_reconcile_max_drift_ratio',
    help: 'Largest relative gap between analytics facts and their source table over the last week, per metric',
    labelNames: ['metric'],
  });

/** The relative gap between facts and source (0 when both are empty). */
export const drift = (facts: number, source: number) =>
  facts === source ? 0 : Math.abs(facts - source) / Math.max(source, 1);

@Injectable()
export class AnalyticsReconcile implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(FACTS_MAINTENANCE) private readonly maintenance: FactsMaintenance,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit() {
    this.timer = setInterval(
      () =>
        void this.runDaily().catch((err: unknown) => this.logger.warn({ err }, 'analytics reconcile failed')),
      EVERY_MS,
    );
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** Runs when today's reconciliation has not run yet. */
  async runDaily(): Promise<void> {
    const now = this.clock.now();
    const last = await this.maintenance.watermark(WATERMARK);
    if (last && last.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) return;
    await this.maintenance.exclusively(WATERMARK, async () => {
      await this.reconcile(now);
      await this.maintenance.setWatermark(WATERMARK, now);
    });
  }

  async reconcile(now: Date) {
    // The last week, minus the last hour (events still on their way).
    const to = new Date(now.getTime() - 3_600_000);
    const from = new Date(to.getTime() - 7 * 86_400_000);
    const counts = await this.maintenance.reconcileCounts(from, to);
    const worst = new Map<string, number>([
      ['emails_sent', 0],
      ['leads', 0],
      ['jobs_finished', 0],
    ]);
    for (const row of counts) {
      const gap = drift(row.facts, row.source);
      worst.set(row.metric, Math.max(worst.get(row.metric) ?? 0, gap));
      if (gap > DRIFT_THRESHOLD)
        this.logger.warn(
          { organizationId: row.organizationId, metric: row.metric, facts: row.facts, source: row.source },
          'analytics facts drift from their source',
        );
    }
    for (const [metric, gap] of worst) maxDrift().set({ metric }, gap);
    return counts;
  }
}
