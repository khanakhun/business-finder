import {
  type Clock,
  type DomainEvent,
  type MailboxHealthStats,
  OutreachMessageBounced,
  OutreachReplyTriaged,
  UnsubscribeConfirmed,
} from '@bf/contracts';
import { metrics } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { OnDomainEvent } from '../../../platform/events/on-domain-event.decorator.ts';
import { LOGGER, type Logger } from '../../../platform/logging/logger.ts';
import { evaluateRules } from '../../domain/deliverability/rules.ts';
import { MailboxLifecycle } from '../mailbox/mailbox-lifecycle.ts';
import { MAILBOX_REPOSITORY, type MailboxRepository } from '../mailbox/ports.ts';
import { DELIVERABILITY_REPOSITORY, type DeliverabilityRepository } from './ports.ts';

// Mailbox health and auto-pause (BF-056, Observer): every hard bounce, unsubscribe and negative reply re-evaluates
// the sending mailbox's rolling windows against the rules at once (no waiting for a batch); a rule that trips pauses
// the mailbox through its lifecycle — owners are notified, queued messages wait (the send worker puts them back) and
// resuming needs the BF-050 checks plus a confirmation.

const paused = () =>
  metrics.counter({
    name: 'bf_outreach_mailbox_paused_total',
    help: 'Mailboxes paused automatically by a deliverability rule, by reason',
    labelNames: ['reason'],
  });

const bounceRate = () =>
  metrics.gauge({
    name: 'bf_outreach_mailbox_bounce_rate',
    help: 'Hard bounce rate over the last 50 sends, per mailbox',
    labelNames: ['mailbox'],
  });

const rate = (count: number, n: number) => ({ n, count, rate: n > 0 ? count / n : null });

@Injectable()
export class DeliverabilityHealth {
  constructor(
    @Inject(DELIVERABILITY_REPOSITORY) private readonly repository: DeliverabilityRepository,
    @Inject(MAILBOX_REPOSITORY) private readonly mailboxes: MailboxRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly lifecycle: MailboxLifecycle,
  ) {}

  async stats(organizationId: string): Promise<MailboxHealthStats[]> {
    const now = this.clock.now();
    const mailboxes = (await this.mailboxes.list(organizationId)).filter(
      (mailbox) => !mailbox.disconnectedAt,
    );
    return Promise.all(
      mailboxes.map(async (mailbox) => {
        const row = await this.repository.health(mailbox.id, now);
        const verdict = evaluateRules({ ...row, warming: mailbox.status === 'warming' });
        const replies7d = row.negative7d + row.positive7d;
        return {
          mailboxId: mailbox.id,
          email: mailbox.email,
          status: mailbox.status,
          sends24h: row.sends24h,
          sends7d: row.sends7d,
          bounces: rate(row.last50Bounces, row.last50Sends),
          bounces24h: row.bounces24h,
          unsubscribes7d: rate(row.unsubscribes7d, row.sends7d),
          negative7d: rate(row.negative7d, row.sends7d),
          positive7d: rate(row.positive7d, row.sends7d),
          deferrals7d: row.deferrals7d,
          autoReplies7d: rate(row.autoReplies7d, replies7d + row.autoReplies7d),
          warnings: verdict.pause ? [`would_pause:${verdict.pause}`, ...verdict.warnings] : verdict.warnings,
          daily: row.daily,
        };
      }),
    );
  }

  /** Re-evaluates one mailbox; pauses it when a rule trips. */
  async evaluate(organizationId: string, mailboxId: string): Promise<string | null> {
    const mailbox = await this.mailboxes.find(organizationId, mailboxId);
    if (!mailbox || (mailbox.status !== 'active' && mailbox.status !== 'warming')) return null;
    const row = await this.repository.health(mailbox.id, this.clock.now());
    if (row.last50Sends > 0) bounceRate().set({ mailbox: mailbox.id }, row.last50Bounces / row.last50Sends);
    const verdict = evaluateRules({ ...row, warming: mailbox.status === 'warming' });
    if (!verdict.pause) return null;
    try {
      await this.lifecycle.transition(mailbox, 'paused', {
        reason: `deliverability: ${verdict.pause}`,
        automatic: true,
        actorUserId: null,
      });
      paused().inc({ reason: verdict.pause });
      this.logger.warn({ mailboxId, reason: verdict.pause }, 'mailbox paused by a deliverability rule');
    } catch (error) {
      this.logger.warn({ err: error, mailboxId }, 'deliverability pause failed');
    }
    return verdict.pause;
  }

  private async fromMessage(messageId: string | null) {
    if (!messageId) return;
    const owner = await this.repository.mailboxOfMessage(messageId);
    if (owner) await this.evaluate(owner.organizationId, owner.mailboxId);
  }

  @OnDomainEvent(OutreachMessageBounced, { id: 'outreach.health-on-bounce' })
  async onBounce(event: DomainEvent<typeof OutreachMessageBounced>): Promise<void> {
    if (event.orgId && event.payload.mailboxId) await this.evaluate(event.orgId, event.payload.mailboxId);
  }

  @OnDomainEvent(UnsubscribeConfirmed, { id: 'outreach.health-on-unsubscribe' })
  async onUnsubscribe(event: DomainEvent<typeof UnsubscribeConfirmed>): Promise<void> {
    await this.fromMessage(event.payload.outboundMessageId);
  }

  @OnDomainEvent(OutreachReplyTriaged, { id: 'outreach.health-on-reply' })
  async onReply(event: DomainEvent<typeof OutreachReplyTriaged>): Promise<void> {
    if (event.payload.class === 'negative' || event.payload.class === 'unsubscribe')
      await this.fromMessage(event.payload.outboundMessageId);
  }
}
