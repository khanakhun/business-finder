import type { Clock } from '@bf/contracts';
import { metrics } from '@bf/observability';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { LOGGER, type Logger } from '../../platform/logging/logger.ts';
import { FACTS_MAINTENANCE, FACTS_STORE, type FactsMaintenance, type FactsStore } from './ports.ts';

// The 15-minute refresh (BF-058, worker): one worker at a time (an advisory lock) keeps the monthly partitions three
// months ahead, reads the cost ledgers since their watermarks (model calls with an hour of overlap, provider days
// with three — keys make the overlap harmless), and rebuilds the daily rollup for the days that got new facts.

const EVERY_MS = 15 * 60_000;
const FIRST_RUN_MS = 30_000;
const HOUR = 3_600_000;

export const LLM_WATERMARK = 'llm_calls';
const PROVIDER_WATERMARK = 'provider_usage';
const DAILY_WATERMARK = 'analytics_daily';

const duration = () =>
  metrics.histogram({
    name: 'bf_analytics_refresh_seconds',
    help: 'Duration of the analytics refresh (cost ledgers, rollups, partitions)',
    buckets: [0.5, 1, 5, 15, 60, 300],
  });
const lastRun = () =>
  metrics.gauge({
    name: 'bf_analytics_refresh_last_success_timestamp_seconds',
    help: 'When the analytics refresh last succeeded',
  });

@Injectable()
export class AnalyticsRefresh implements OnModuleInit, OnModuleDestroy {
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    @Inject(FACTS_STORE) private readonly store: FactsStore,
    @Inject(FACTS_MAINTENANCE) private readonly maintenance: FactsMaintenance,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit() {
    const run = () =>
      void this.run().catch((err: unknown) => this.logger.warn({ err }, 'analytics refresh failed'));
    this.timers = [setTimeout(run, FIRST_RUN_MS), setInterval(run, EVERY_MS)];
    for (const timer of this.timers) timer.unref();
  }

  onModuleDestroy() {
    for (const timer of this.timers) clearTimeout(timer);
  }

  async run(): Promise<boolean> {
    const started = this.clock.now();
    const ran = await this.maintenance.exclusively('refresh', async () => {
      await this.maintenance.ensurePartitions(3);
      const llmSince =
        (await this.maintenance.watermark(LLM_WATERMARK)) ?? new Date(started.getTime() - 24 * HOUR);
      const llm = await this.store.ingest('llmCosts', { since: new Date(llmSince.getTime() - HOUR) });
      await this.maintenance.setWatermark(LLM_WATERMARK, started);
      const providerSince =
        (await this.maintenance.watermark(PROVIDER_WATERMARK)) ?? new Date(started.getTime() - 24 * HOUR);
      const providers = await this.store.ingest('providerCosts', {
        since: new Date(providerSince.getTime() - 72 * HOUR),
      });
      await this.maintenance.setWatermark(PROVIDER_WATERMARK, started);
      const dailySince = (await this.maintenance.watermark(DAILY_WATERMARK)) ?? new Date(0);
      // A minute of overlap: a fact committed while the last refresh read is not missed.
      const days = await this.maintenance.refreshDaily(new Date(dailySince.getTime() - 60_000));
      await this.maintenance.setWatermark(DAILY_WATERMARK, started);
      this.logger.info({ llm, providers, days }, 'analytics refreshed');
    });
    if (ran) {
      duration().observe((this.clock.now().getTime() - started.getTime()) / 1_000);
      lastRun().set(started.getTime() / 1_000);
    }
    return ran;
  }
}
