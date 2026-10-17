import { type Clock } from '@bf/contracts';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { LOGGER, type Logger } from '../../platform/logging/logger.ts';
import { LEADS_REPOSITORY, type LeadsRepository } from './ports.ts';

// Lead retention (BF-048): leads are deleted after `LEADS_RETENTION_DAYS` (default 730), spam after
// `LEADS_SPAM_RETENTION_DAYS` (default 30); the worker purges every hour, in batches (idempotent).

export const LEADS_RETENTION = Symbol('LeadsRetention');
const EVERY_MS = 60 * 60_000;
const BATCH = 500;

@Injectable()
export class LeadsRetention implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(LEADS_REPOSITORY) private readonly repository: LeadsRepository,
    @Inject(LEADS_RETENTION) private readonly days: { readonly leads: number; readonly spam: number },
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit() {
    this.timer = setInterval(
      () => void this.purge().catch((err: unknown) => this.logger.warn({ err }, 'lead purge failed')),
      EVERY_MS,
    );
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async purge(): Promise<number> {
    const now = this.clock.now().getTime();
    const before = new Date(now - this.days.leads * 86_400_000);
    const spamBefore = new Date(now - this.days.spam * 86_400_000);
    let total = 0;
    for (;;) {
      const deleted = await this.repository.deleteBefore(before, spamBefore, BATCH);
      total += deleted;
      if (deleted < BATCH) break;
    }
    if (total > 0) this.logger.info({ deleted: total }, 'site leads purged');
    return total;
  }
}
