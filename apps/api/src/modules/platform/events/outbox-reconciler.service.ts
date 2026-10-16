import type { Clock } from '@bf/contracts';
import { type Logger, metrics } from '@bf/observability';
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { CLOCK } from '../clock/clock.module.ts';
import { LOGGER } from '../logging/logger.ts';
import { OutboxRepository } from './outbox.repository.ts';
import { OUTBOX_RELAY_OPTIONS, OutboxRelay, type OutboxRelayOptions } from './outbox-relay.service.ts';

/** Events still undispatched this long after being recorded count as stuck. */
export const STUCK_AFTER_MS = 5 * 60_000;
const INTERVAL_MS = 60_000;

const pending = () =>
  metrics.gauge({ name: 'bf_outbox_pending_events', help: 'Recorded events not dispatched yet' });
const released = () =>
  metrics.counter({ name: 'bf_outbox_stuck_events_released_total', help: 'Stuck events made due again' });

/**
 * Safety net (worker): makes events stuck in backoff for more than `STUCK_AFTER_MS` due again, re-runs the relay,
 * and publishes the pending count for alerting.
 */
@Injectable()
export class OutboxReconciler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly outbox: OutboxRepository,
    private readonly relay: OutboxRelay,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(OUTBOX_RELAY_OPTIONS) private readonly options: OutboxRelayOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.autoStart) return;
    this.timer = setInterval(() => {
      this.reconcile().catch((error: unknown) =>
        this.logger.error({ err: error }, 'outbox reconcile failed'),
      );
    }, INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  async reconcile(): Promise<{ released: number; pending: number }> {
    const now = this.clock.now();
    const count = await this.outbox.releaseStuck(new Date(now.getTime() - STUCK_AFTER_MS), now);
    if (count > 0) {
      released().inc(count);
      this.logger.warn({ count }, 'outbox events were stuck; dispatching them again');
      this.relay.wake();
    }
    const waiting = await this.outbox.pendingCount();
    pending().set(waiting);
    return { released: count, pending: waiting };
  }
}
