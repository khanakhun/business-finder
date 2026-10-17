import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../../platform/clock/clock.module.ts';
import { LOGGER, type Logger } from '../../platform/logging/logger.ts';
import { SITE_CHAT_REPOSITORY, type SiteChatRepository } from './ports.ts';

// Site chats are kept `SITE_CHAT_RETENTION_DAYS` after their last message (BF-047): the worker deletes older threads
// (with their messages and proposals) every hour. Deletes are idempotent, so several workers may run it.

export const SITE_CHAT_RETENTION_DAYS = Symbol('SiteChatRetentionDays');
const EVERY_MS = 60 * 60_000;
const BATCH = 500;

@Injectable()
export class SiteChatRetention implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(SITE_CHAT_REPOSITORY) private readonly repository: SiteChatRepository,
    @Inject(SITE_CHAT_RETENTION_DAYS) private readonly days: number,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit() {
    this.timer = setInterval(
      () => void this.purge().catch((err: unknown) => this.logger.warn({ err }, 'site chat purge failed')),
      EVERY_MS,
    );
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Deletes the threads older than the retention; returns how many. */
  async purge(): Promise<number> {
    const before = new Date(this.clock.now().getTime() - this.days * 86_400_000);
    let total = 0;
    for (;;) {
      const deleted = await this.repository.deleteThreadsBefore(before, BATCH);
      total += deleted;
      if (deleted < BATCH) break;
    }
    if (total > 0) this.logger.info({ deleted: total }, 'site chat threads purged');
    return total;
  }
}
