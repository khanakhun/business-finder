import type { Clock } from '@bf/contracts';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit, Optional } from '@nestjs/common';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { LOGGER, type Logger } from '../../../platform/logging/logger.ts';
import { rampComplete } from '../../domain/mailbox/capacity-policy.ts';
import { DeliverabilityService } from '../deliverability/deliverability.service.ts';
import { MailboxLifecycle } from './mailbox-lifecycle.ts';
import { MailboxesService } from './mailboxes.service.ts';
import { MAILBOX_REPOSITORY, type MailboxRepository, RUN_LOCK, type RunLock } from './ports.ts';

// The hourly mailbox sweep (BF-050, worker only): each connected mailbox's health is checked (token, reachability,
// quota) and recorded; authentication failures move it to `error`; a warming mailbox whose ramp is complete
// becomes `active`. One sweep at a time across workers (Valkey lock).

const EVERY_MS = 60 * 60_000;
const BATCH = 100;

@Injectable()
export class MailboxHealthSweep implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(MAILBOX_REPOSITORY) private readonly repository: MailboxRepository,
    @Inject(RUN_LOCK) private readonly lock: RunLock,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly mailboxes: MailboxesService,
    private readonly lifecycle: MailboxLifecycle,
    @Optional() private readonly deliverability?: DeliverabilityService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(
      () =>
        void this.sweep().catch((err: unknown) => this.logger.warn({ err }, 'mailbox health sweep failed')),
      EVERY_MS,
    );
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<number> {
    if (!(await this.lock.acquire('outreach:mailbox-health', Math.floor(EVERY_MS / 1000) - 60))) return 0;
    let checked = 0;
    let afterId: string | undefined;
    for (;;) {
      const batch = await this.repository.listForHealth(BATCH, afterId);
      for (const mailbox of batch) {
        checked++;
        try {
          const { mailbox: current } = await this.mailboxes.checkHealth(mailbox);
          // BF-056: the domain's authentication, re-checked once a day.
          await this.deliverability
            ?.ensureFresh(current)
            .catch((err: unknown) => this.logger.warn({ err, mailboxId: mailbox.id }, 'domain check failed'));
          if (current.status === 'warming' && rampComplete(current, this.clock.now()))
            await this.lifecycle.transition(current, 'active', {
              reason: 'ramp complete',
              automatic: true,
              actorUserId: null,
            });
        } catch (err) {
          this.logger.warn({ err, mailboxId: mailbox.id }, 'mailbox health check failed');
        }
      }
      if (batch.length < BATCH) break;
      afterId = batch.at(-1)?.id;
    }
    if (checked > 0) this.logger.info({ checked }, 'mailbox health sweep done');
    return checked;
  }
}
