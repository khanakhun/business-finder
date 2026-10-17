import {
  type Clock,
  type OrgId,
  OutreachBulkDraftJob,
  OutreachSendJob,
  OutreachSyncJob,
  OutreachTickJob,
  OutreachTriageJob,
} from '@bf/contracts';
import { type JobContext, QUEUES, TypedProducer } from '@bf/queue';
import { InjectQueue, Processor } from '@nestjs/bullmq';
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { z } from 'zod';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { LOGGER, type Logger } from '../../../platform/logging/logger.ts';
import { TypedProcessor } from '../../../platform/queue/typed-processor.ts';
import {
  INBOUND_QUEUES,
  INBOUND_REPOSITORY,
  type InboundQueues,
  type InboundRepository,
} from '../../application/inbound/ports.ts';
import { MailboxSync } from '../../application/inbound/sync.ts';
import { ReplyTriageService } from '../../application/inbound/triage.ts';
import { BulkOutreach } from '../../application/outbound/bulk.ts';
import {
  BULK_REPOSITORY,
  type BulkRepository,
  OUTBOUND_REPOSITORY,
  type OutboundRecord,
  type OutboundRepository,
} from '../../application/outbound/ports.ts';
import { MAX_SEND_ATTEMPTS } from '../../domain/outbound/outbound-message.ts';
import { outboundMetrics } from './outbound-metrics.ts';
import { OutboundSender } from './outbound-sender.ts';

// The DB-backed scheduler of the outbound pipeline (BF-052, ADR-0006): the database is the truth, BullMQ only runs
// attempts. Each minute: failed messages due for a retry go back to the queue, sends whose lease ran out are leased
// again (the attempt reconciles first), and due messages are claimed in small batches and handed to the send queue
// (one job per claim: the lease is part of its key, so a lost job is replaced by the next claim, never doubled).

const LEASE_MS = 5 * 60_000;
const BATCH = 50;
const MAX_BATCHES = 20;
/** A send still running this long after its lease is stuck (the alert). */
const STUCK_AFTER_MS = 10 * 60_000;

export const OUTREACH_TICK_AUTOSTART = Symbol('OutreachTickAutostart');

/** Enqueues the tick (one job per minute, whatever the number of processes). */
@Injectable()
export class OutreachTickScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly jobs: TypedProducer<typeof OutreachTickJob>;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @InjectQueue(QUEUES.outreachTick.name) queue: Queue,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(OUTREACH_TICK_AUTOSTART) private readonly autostart: boolean,
  ) {
    this.jobs = new TypedProducer(queue, OutreachTickJob);
  }

  onApplicationBootstrap(): void {
    if (!this.autostart) return;
    const run = () =>
      this.tick().catch((error: unknown) =>
        this.logger.error({ err: error }, 'outreach tick scheduling failed'),
      );
    void run();
    this.timer = setInterval(run, 20_000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  async tick(now = new Date()): Promise<void> {
    await this.jobs.add({ orgId: null, idempotencyKey: `tick:${now.toISOString().slice(0, 16)}` });
  }
}

@Processor(QUEUES.outreachTick.name, { concurrency: QUEUES.outreachTick.concurrency })
export class OutreachTickProcessor extends TypedProcessor<
  typeof OutreachTickJob,
  { readonly claimed: number; readonly released: number; readonly retried: number }
> {
  protected readonly definition = OutreachTickJob;
  private readonly sends: TypedProducer<typeof OutreachSendJob>;

  constructor(
    @Inject(OUTBOUND_REPOSITORY) private readonly messages: OutboundRepository,
    @Inject(BULK_REPOSITORY) private readonly bulk: BulkRepository,
    @Inject(INBOUND_REPOSITORY) private readonly inbound: InboundRepository,
    @Inject(INBOUND_QUEUES) private readonly inboundQueues: InboundQueues,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectQueue(QUEUES.outreachSend.name) sendQueue: Queue,
  ) {
    super();
    this.sends = new TypedProducer(sendQueue, OutreachSendJob);
  }

  async handle(_payload: z.output<typeof OutreachTickJob.schema>, context: JobContext) {
    const now = this.clock.now();
    const lease = new Date(now.getTime() + LEASE_MS);
    const retried = await this.messages.requeueRetries(now, MAX_SEND_ATTEMPTS, BATCH * MAX_BATCHES);
    const released = await this.messages.releaseExpired(now, lease, BATCH);
    await this.enqueue(released, lease);
    let claimed = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const rows = await this.messages.claimDue(now, lease, BATCH);
      await this.enqueue(rows, lease);
      claimed += rows.length;
      if (rows.length < BATCH) break;
    }
    outboundMetrics.stuck().set(await this.messages.countStuck(new Date(now.getTime() - STUCK_AFTER_MS)));
    outboundMetrics.approvalsPending().set(await this.bulk.countPendingApprovals());
    // Replies (BF-054): mailboxes whose next poll is due.
    const minute = now.toISOString().slice(0, 16);
    for (const mailbox of await this.inbound.dueMailboxes(now, 200))
      await this.inboundQueues.sync(mailbox.organizationId, mailbox.id, `sync:${mailbox.id}:${minute}`);
    if (claimed + released.length + retried > 0)
      context.logger.info({ claimed, released: released.length, retried }, 'outreach tick');
    return { claimed, released: released.length, retried };
  }

  private async enqueue(rows: readonly OutboundRecord[], lease: Date) {
    for (const row of rows)
      await this.sends.add({
        orgId: row.organizationId as OrgId,
        idempotencyKey: `send:${row.id}:${lease.toISOString()}`,
        messageId: row.id,
        lease: lease.toISOString(),
      });
  }
}

@Processor(QUEUES.outreachSend.name, { concurrency: QUEUES.outreachSend.concurrency })
export class OutreachSendProcessor extends TypedProcessor<
  typeof OutreachSendJob,
  { readonly outcome: string }
> {
  protected readonly definition = OutreachSendJob;

  constructor(private readonly sender: OutboundSender) {
    super();
  }

  async handle(payload: z.output<typeof OutreachSendJob.schema>, context: JobContext) {
    const outcome = await this.sender.send(payload.messageId, payload.lease, context.logger);
    context.logger.info({ messageId: payload.messageId, outcome }, 'outreach send');
    return { outcome };
  }
}

@Processor(QUEUES.outreachBulk.name, { concurrency: QUEUES.outreachBulk.concurrency })
export class OutreachBulkProcessor extends TypedProcessor<
  typeof OutreachBulkDraftJob,
  { readonly outcome: string }
> {
  protected readonly definition = OutreachBulkDraftJob;

  constructor(private readonly bulk: BulkOutreach) {
    super();
  }

  async handle(payload: z.output<typeof OutreachBulkDraftJob.schema>, context: JobContext) {
    const outcome = await this.bulk.draftOne(payload.runId, payload.businessId, context.logger);
    return { outcome };
  }
}

@Processor(QUEUES.outreachSync.name, { concurrency: QUEUES.outreachSync.concurrency })
export class OutreachSyncProcessor extends TypedProcessor<
  typeof OutreachSyncJob,
  { readonly ingested: number; readonly ignored: number }
> {
  protected readonly definition = OutreachSyncJob;

  constructor(private readonly sync: MailboxSync) {
    super();
  }

  async handle(payload: z.output<typeof OutreachSyncJob.schema>, context: JobContext) {
    if (!payload.orgId) return { ingested: 0, ignored: 0 };
    return this.sync.sync(payload.orgId, payload.mailboxId, context.logger);
  }
}

@Processor(QUEUES.outreachTriage.name, { concurrency: QUEUES.outreachTriage.concurrency })
export class OutreachTriageProcessor extends TypedProcessor<
  typeof OutreachTriageJob,
  { readonly outcome: string }
> {
  protected readonly definition = OutreachTriageJob;

  constructor(private readonly triage: ReplyTriageService) {
    super();
  }

  async handle(payload: z.output<typeof OutreachTriageJob.schema>, context: JobContext) {
    return { outcome: await this.triage.triage(payload.inboundId, context.logger) };
  }
}
