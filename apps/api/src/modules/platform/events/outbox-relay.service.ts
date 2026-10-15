import { type Clock, EventDeliveryJob } from '@bf/contracts';
import { type DbClient, runInTransaction } from '@bf/db';
import { type Logger, metrics, runWithExtractedContext } from '@bf/observability';
import { QUEUES, TypedProducer } from '@bf/queue';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { CLOCK } from '../clock/clock.module.ts';
import { DB_CLIENT } from '../db/db.module.ts';
import { LOGGER } from '../logging/logger.ts';
import { OUTBOX_CHANNEL } from './event-recorder.ts';
import { OutboxRepository, type OutboxRow } from './outbox.repository.ts';
import { SubscriberRegistry } from './subscriber-registry.ts';

export interface OutboxRelayOptions {
  /** Polling fallback when no NOTIFY arrives (Postgres restarts, missed notifications). */
  readonly pollMs: number;
  readonly batchSize: number;
  /** Background loop (LISTEN + polling). Off in tests that drive `drain()` themselves. */
  readonly autoStart: boolean;
}
export const OUTBOX_RELAY_OPTIONS = Symbol('OutboxRelayOptions');
export const DEFAULT_RELAY_OPTIONS: OutboxRelayOptions = { pollMs: 2_000, batchSize: 100, autoStart: true };

const MAX_BACKOFF_MS = 5 * 60_000;
const lag = () =>
  metrics.histogram({
    name: 'bf_outbox_dispatch_lag_seconds',
    help: 'Time from an event being recorded to its dispatch to subscribers',
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  });
const dispatched = () =>
  metrics.counter({
    name: 'bf_outbox_events_dispatched_total',
    help: 'Events dispatched by the relay',
    labelNames: ['type'],
  });
const deliveries = () =>
  metrics.counter({
    name: 'bf_outbox_deliveries_enqueued_total',
    help: 'Subscriber deliveries enqueued (event × subscriber)',
  });
const failures = () =>
  metrics.counter({
    name: 'bf_outbox_dispatch_failures_total',
    help: 'Relay attempts that failed and will retry',
  });

/**
 * Outbox relay (worker): wakes on `NOTIFY bf_outbox` and every `pollMs`, claims due events with `FOR UPDATE SKIP
 * LOCKED` (several relays never dispatch the same event concurrently), enqueues one BullMQ job per event ×
 * subscriber keyed `<eventId>:<subscriberId>`, and marks the event dispatched in the same transaction. A crash
 * between enqueue and commit re-dispatches later; duplicate jobs collapse on the job id or the idempotency guard.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly producer: TypedProducer<typeof EventDeliveryJob>;
  private timer: NodeJS.Timeout | undefined;
  private listener: { unlisten(): Promise<void> } | undefined;
  private listening: Promise<void> | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private stopped = false;

  constructor(
    private readonly outbox: OutboxRepository,
    private readonly registry: SubscriberRegistry,
    @InjectQueue(QUEUES.events.name) queue: Queue,
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(OUTBOX_RELAY_OPTIONS) private readonly options: OutboxRelayOptions,
  ) {
    this.producer = new TypedProducer(queue, EventDeliveryJob);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.options.autoStart) return;
    await this.listen();
    this.timer = setInterval(() => {
      if (!this.listener && !this.listening) void this.listen();
      this.wake();
    }, this.options.pollMs);
    this.timer.unref();
    this.wake();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.listener?.unlisten().catch(() => undefined);
    await this.running;
  }

  /** Schedules a drain; concurrent wake-ups coalesce into one more pass. */
  wake(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.drain()
      .then(() => undefined)
      .catch((error: unknown) => this.logger.error({ err: error }, 'outbox relay pass failed'))
      .finally(() => {
        this.running = undefined;
        if (this.again) {
          this.again = false;
          this.wake();
        }
      });
  }

  /** Dispatches due events until none are left; returns how many were dispatched. */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const { claimed, ok } = await this.dispatchBatch();
      total += ok;
      if (claimed < this.options.batchSize || this.stopped) return total;
    }
  }

  private async dispatchBatch(): Promise<{ claimed: number; ok: number }> {
    return runInTransaction(this.db, async () => {
      const now = this.clock.now();
      const rows = await this.outbox.claimPending(this.options.batchSize, now);
      const ok: string[] = [];
      for (const row of rows) {
        try {
          await this.dispatch(row);
          ok.push(row.id);
          lag().observe(Math.max(0, now.getTime() - row.occurredAt.getTime()) / 1000);
          dispatched().inc({ type: row.type });
        } catch (error) {
          failures().inc();
          const delay = Math.min(1_000 * 2 ** row.attempts, MAX_BACKOFF_MS);
          this.logger.warn(
            { err: error, eventId: row.id, type: row.type, attempt: row.attempts + 1 },
            'event dispatch failed',
          );
          await this.outbox.markFailed(
            row.id,
            String((error as Error).message ?? error),
            new Date(now.getTime() + delay),
          );
        }
      }
      await this.outbox.markDispatched(ok, now);
      return { claimed: rows.length, ok: ok.length };
    });
  }

  private async dispatch(row: OutboxRow): Promise<void> {
    const subscribers = this.registry.subscribersFor(row.type, row.version);
    if (subscribers.length === 0) return;
    const carrier = row.context.traceparent ? { traceparent: row.context.traceparent } : undefined;
    // Delivery jobs continue the trace of the request that recorded the event.
    await runWithExtractedContext(carrier, `outbox.dispatch ${row.type}`, () =>
      Promise.all(
        subscribers.map((subscriber) =>
          this.producer.add({
            idempotencyKey: `${row.id}:${subscriber.id}`,
            orgId: row.organizationId,
            eventId: row.id,
            subscriberId: subscriber.id,
          }),
        ),
      ),
    );
    deliveries().inc(subscribers.length);
  }

  private listen(): Promise<void> {
    this.listening ??= (async () => {
      try {
        const listener = await this.db.$client.listen(OUTBOX_CHANNEL, () => this.wake());
        if (this.stopped) await listener.unlisten();
        else this.listener = listener;
      } catch (error) {
        // Polling keeps the relay working; the timer retries LISTEN.
        this.logger.warn({ err: error }, 'outbox relay could not LISTEN; polling only');
      } finally {
        this.listening = undefined;
      }
    })();
    return this.listening;
  }
}
