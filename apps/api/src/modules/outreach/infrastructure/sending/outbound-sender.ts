import {
  type Clock,
  type ComplianceDecision,
  type OutboundError,
  type OutboundStatus,
  OutreachMessageBlocked,
  OutreachMessageFailed,
  OutreachMessageSent,
} from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ComplianceService } from '../../../compliance/index.ts';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { EventRecorder } from '../../../platform/events/event-recorder.ts';
import { KillSwitchService } from '../../application/deliverability/kill-switch.ts';
import { MAILBOX_READINESS, type MailboxReadinessGate } from '../../application/deliverability/ports.ts';
import { MailboxCapacity } from '../../application/mailbox/mailbox-capacity.ts';
import { MailboxesService } from '../../application/mailbox/mailboxes.service.ts';
import {
  MAILBOX_REPOSITORY,
  type MailboxRecord,
  type MailboxRepository,
  type SendResult,
} from '../../application/mailbox/ports.ts';
import {
  OUTBOUND_REPOSITORY,
  type OutboundPatch,
  type OutboundRecord,
  type OutboundRepository,
} from '../../application/outbound/ports.ts';
import { MailboxProviderError } from '../../domain/mailbox/errors.ts';
import { canSend } from '../../domain/mailbox/mailbox-state-machine.ts';
import { MAX_SEND_ATTEMPTS } from '../../domain/outbound/outbound-message.ts';
import { assertTransition } from '../../domain/outbound/state-machine.ts';
import { composeMime } from './mime-composer.ts';
import { outboundMetrics } from './outbound-metrics.ts';

// One send attempt of a leased message (BF-052), the only place a prospect email reaches a provider:
//   1. a message attempted before is first looked for in the mailbox's sent items (exactly-once effect: never
//      resend without reconciliation);
//   2. compliance is evaluated again (stage `send`): a suppression or a status change since enqueue blocks it;
//   3. the mailbox's next slot and an atomic capacity reservation — none: back to `queued` at the next slot (not an
//      attempt);
//   4. the MIME is built from what was queued and sent once, with a timeout; an unknown outcome is reconciled.
// Retryable failures are retried with backoff (at most 3 attempts); permanent ones are final.

export type SendOutcome = 'sent' | 'reconciled' | 'blocked' | 'requeued' | 'failed' | 'stale';

const SEND_TIMEOUT_MS = 60_000;
const RECONCILE_TIMEOUT_MS = 30_000;
/** A slot further away than this is not "now": the message waits for it in the queue. */
const SLOT_TOLERANCE_MS = 60_000;
const BACKOFF_MINUTES = [1, 5, 15];

const MIN = 60_000;

@Injectable()
export class OutboundSender {
  constructor(
    @Inject(OUTBOUND_REPOSITORY) private readonly messages: OutboundRepository,
    @Inject(MAILBOX_REPOSITORY) private readonly mailboxRepository: MailboxRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly mailboxes: MailboxesService,
    private readonly capacity: MailboxCapacity,
    private readonly compliance: ComplianceService,
    private readonly events: EventRecorder,
    @Optional() @Inject(MAILBOX_READINESS) private readonly readiness?: MailboxReadinessGate,
    @Optional() private readonly killSwitch?: KillSwitchService,
  ) {}

  async send(messageId: string, leaseIso: string, logger: Logger): Promise<SendOutcome> {
    const lease = new Date(leaseIso);
    const message = await this.messages.byId(messageId);
    if (!message || message.status !== 'sending' || message.leaseUntil?.getTime() !== lease.getTime())
      return 'stale';
    const log = logger.child({ messageId, organizationId: message.organizationId });
    const mailbox = message.mailboxId
      ? await this.mailboxRepository.find(message.organizationId, message.mailboxId)
      : undefined;
    if (!mailbox || mailbox.disconnectedAt || !canSend(mailbox.status))
      // A paused, failed or disconnected sender: the message waits (follow-ups never silently switch sender).
      return this.requeue(
        message,
        lease,
        new Date(this.clock.now().getTime() + 60 * MIN),
        'mailbox unavailable',
      );
    // BF-056: the workspace's kill switch stops every send at once; the message waits for it to be lifted.
    if (this.killSwitch && (await this.killSwitch.isActive(message.organizationId)))
      return this.requeue(message, lease, new Date(this.clock.now().getTime() + 15 * MIN), 'kill switch');
    // BF-056: the domain's authentication regressed (no owner override): the message waits for the fix.
    if (this.readiness && !(await this.readiness.isReady(mailbox.organizationId, mailbox.id, mailbox.email)))
      return this.requeue(
        message,
        lease,
        new Date(this.clock.now().getTime() + 60 * MIN),
        'domain authentication failing',
      );

    // 1. Reconcile a previous attempt before anything else.
    if (message.attempts > 0) {
      const found = await this.reconcile(message, mailbox, log);
      if (found === 'unknown') return this.fail(message, lease, unknownOutcome(this.clock.now()), log);
      if (found) return this.markSent(message, lease, mailbox, found, null, 'reconciled');
    }

    // 2. Send-time compliance.
    const decision = await this.compliance.evaluate(
      {
        organizationId: message.organizationId,
        businessId: message.businessId,
        ...(message.contactId ? { contactId: message.contactId } : {}),
      },
      'email',
      { purpose: message.offer, stage: 'send' },
    );
    if (decision.decision !== 'allowed' && decision.decision !== 'allowed_with_conditions')
      return this.block(message, lease, decision);

    // 3. The mailbox's slot, then capacity.
    const now = this.clock.now();
    const slot = await this.capacity.select({
      organizationId: message.organizationId,
      stickyMailboxId: mailbox.id,
      recipientLocale: message.locale,
      recipientTimeZone: null,
    });
    if (!slot.ok)
      return this.requeue(
        message,
        lease,
        new Date(slot.nextAvailableAt ?? now.getTime() + 30 * MIN),
        slot.reason === 'NO_CAPACITY' ? 'no capacity today' : 'mailbox unavailable',
      );
    const sendAt = new Date(slot.sendAt);
    if (sendAt.getTime() - now.getTime() > SLOT_TOLERANCE_MS)
      return this.requeue(message, lease, sendAt, 'outside the sending window');
    const reservation = await this.capacity.reserve(mailbox, message.toEmail ?? '');
    if (!reservation.ok) {
      outboundMetrics.capacity().inc({ reason: reservation.reason });
      const wait = reservation.reason === 'DOMAIN_LIMIT' ? 60 * MIN : 30 * MIN;
      return this.requeue(message, lease, new Date(now.getTime() + wait), reservation.reason.toLowerCase());
    }

    // 4. Compose, count the attempt, send once.
    let mime: Buffer;
    try {
      mime = await composeMime(message, mailbox, { date: now });
    } catch (error) {
      await this.capacity.release(reservation.token);
      log.error({ err: error }, 'outbound message could not be composed');
      return this.fail(
        message,
        lease,
        permanent('compose_failed', 'The message could not be composed', now),
        log,
      );
    }
    const attempted = await this.messages.updateLeased(message.id, lease, {
      attempts: message.attempts + 1,
      lastAttemptAt: now,
      sendDecisionId: decision.id,
    });
    if (!attempted) {
      await this.capacity.release(reservation.token);
      return 'stale';
    }
    outboundMetrics.queueTime().observe(Math.max(0, (now.getTime() - message.scheduledAt.getTime()) / 1000));
    const started = performance.now();
    const provider = this.mailboxes.provider(mailbox);
    try {
      const sent = await provider.sendRaw(this.mailboxes.ctx(mailbox), mime, {
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        ...(message.providerThreadId ? { threadHint: message.providerThreadId } : {}),
      });
      outboundMetrics.latency().observe({ provider: mailbox.provider }, (performance.now() - started) / 1000);
      await this.capacity.commit(reservation.token);
      return this.markSent(attempted, lease, mailbox, sent, decision.id, 'sent');
    } catch (error) {
      return this.afterError(attempted, lease, mailbox, reservation.token, error, log);
    }
  }

  private async afterError(
    message: OutboundRecord,
    lease: Date,
    mailbox: MailboxRecord,
    token: string,
    error: unknown,
    log: Logger,
  ): Promise<SendOutcome> {
    const now = this.clock.now();
    const providerError = error instanceof MailboxProviderError ? error : null;
    const timedOut =
      error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
    // The provider may have accepted the message before the failure: look before deciding anything.
    if (
      timedOut ||
      !providerError ||
      providerError.reason === 'unknown' ||
      providerError.reason === 'unreachable'
    ) {
      const found = await this.reconcile(message, mailbox, log);
      if (found && found !== 'unknown') {
        await this.capacity.commit(token);
        return this.markSent(message, lease, mailbox, found, message.sendDecisionId, 'reconciled');
      }
      await this.capacity.release(token);
      await this.capacity.record(mailbox, 'failed');
      if (found === 'unknown') return this.fail(message, lease, unknownOutcome(now), log);
      return this.fail(message, lease, retryable('send_failed', describe(error), now), log);
    }
    await this.capacity.release(token);
    await this.capacity.record(mailbox, 'failed');
    if (providerError.needsReconnect || providerError.reason === 'quota_exceeded') {
      // The mailbox goes to `error`/`paused`; the message waits for it (or for a person to reassign it).
      await this.mailboxes.recordProviderError(mailbox, providerError);
      return this.requeue(message, lease, new Date(now.getTime() + 60 * MIN), providerError.reason);
    }
    if (providerError.reason === 'rate_limited')
      return this.requeue(
        message,
        lease,
        new Date(now.getTime() + (providerError.retryAfterSeconds ?? 300) * 1000),
        'rate limited',
      );
    return this.fail(
      message,
      lease,
      providerError.retryable
        ? retryable(providerError.reason, providerError.message, now)
        : permanent(providerError.reason, providerError.message, now),
      log,
    );
  }

  /** The sent message, null when it is not in the sent items, `unknown` when the provider cannot tell. */
  private async reconcile(
    message: OutboundRecord,
    mailbox: MailboxRecord,
    log: Logger,
  ): Promise<SendResult | null | 'unknown'> {
    try {
      const found = await this.mailboxes.provider(mailbox).findSent(
        this.mailboxes.ctx(mailbox),
        {
          rfc822MessageId: message.rfc822MessageId,
          outboundId: message.id,
          to: message.toEmail ?? '',
          subject: message.subject,
          since: message.lastAttemptAt ?? message.createdAt,
        },
        AbortSignal.timeout(RECONCILE_TIMEOUT_MS),
      );
      outboundMetrics.reconciliations().inc({ result: found ? 'found' : 'not_found' });
      return found;
    } catch (error) {
      outboundMetrics.reconciliations().inc({ result: 'unknown' });
      log.warn({ err: error }, 'outbound reconciliation could not tell whether the message was sent');
      return 'unknown';
    }
  }

  private async markSent(
    message: OutboundRecord,
    lease: Date,
    mailbox: MailboxRecord,
    sent: SendResult,
    sendDecisionId: string | null,
    outcome: 'sent' | 'reconciled',
  ): Promise<SendOutcome> {
    const now = this.clock.now();
    let decisionId = sendDecisionId ?? message.sendDecisionId;
    if (!decisionId) {
      // A message found by reconciliation before this attempt was judged: its send-time decision is taken now
      // (the database refuses `sent` without one). The email is already out, whatever it says.
      const decision = await this.compliance.evaluate(
        {
          organizationId: message.organizationId,
          businessId: message.businessId,
          ...(message.contactId ? { contactId: message.contactId } : {}),
        },
        'email',
        { purpose: message.offer, stage: 'send' },
      );
      decisionId = decision.id;
    }
    const moved = await this.move(
      message,
      lease,
      'sent',
      {
        sentAt: now,
        providerMessageId: sent.providerMessageId,
        rfc822MessageId: sent.rfc822MessageId,
        providerThreadId: sent.providerThreadId ?? message.providerThreadId,
        sendDecisionId: decisionId,
        leaseUntil: null,
        lastError: null,
      },
      outcome === 'reconciled' ? 'found in the sent items' : null,
    );
    if (!moved) return 'stale';
    await this.messages.touchThread(message.threadId, now, sent.providerThreadId ?? null);
    outboundMetrics.messages().inc({ status: 'sent', provider: mailbox.provider });
    await this.events.record(OutreachMessageSent, {
      orgId: message.organizationId,
      actor: { type: 'job', id: 'outreach.send' },
      payload: {
        ...ref(message),
        purpose: message.purpose,
        offer: message.offer,
        sequenceEnrollmentId: message.sequenceEnrollmentId,
        sentAt: now.toISOString(),
      },
    });
    return outcome;
  }

  private async block(
    message: OutboundRecord,
    lease: Date,
    decision: ComplianceDecision,
  ): Promise<SendOutcome> {
    const reasons = decision.reasons.map((reason) => reason.code);
    const moved = await this.move(
      message,
      lease,
      'blocked',
      {
        sendDecisionId: decision.id,
        blockedReasons: reasons,
        leaseUntil: null,
      },
      reasons.join(', ') || decision.decision,
    );
    if (!moved) return 'stale';
    for (const reason of reasons.length > 0 ? reasons : ['none'])
      outboundMetrics.blockedAtSend().inc({ reason });
    outboundMetrics.messages().inc({ status: 'blocked', provider: 'none' });
    await this.events.record(OutreachMessageBlocked, {
      orgId: message.organizationId,
      actor: { type: 'job', id: 'outreach.send' },
      payload: { ...ref(message), decisionId: decision.id, reasons },
    });
    return 'blocked';
  }

  /** Back to `queued` for later (no capacity, a closed window, an unavailable mailbox): not a failure. */
  private async requeue(
    message: OutboundRecord,
    lease: Date,
    at: Date,
    detail: string,
  ): Promise<SendOutcome> {
    const moved = await this.move(message, lease, 'queued', { scheduledAt: at, leaseUntil: null }, detail);
    return moved ? 'requeued' : 'stale';
  }

  private async fail(
    message: OutboundRecord,
    lease: Date,
    error: OutboundError,
    log: Logger,
  ): Promise<SendOutcome> {
    const attempts = Math.max(message.attempts, 1);
    const final = !error.retryable || attempts >= MAX_SEND_ATTEMPTS;
    const delay = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)] ?? 15;
    const moved = await this.move(
      message,
      lease,
      'failed',
      {
        lastError: final && error.retryable ? { ...error, retryable: false } : error,
        scheduledAt: new Date(this.clock.now().getTime() + delay * MIN),
        leaseUntil: null,
      },
      error.code,
    );
    if (!moved) return 'stale';
    log.warn({ code: error.code, attempts, final }, 'outbound send failed');
    outboundMetrics.messages().inc({ status: 'failed', provider: 'any' });
    await this.events.record(OutreachMessageFailed, {
      orgId: message.organizationId,
      actor: { type: 'job', id: 'outreach.send' },
      payload: { ...ref(message), code: error.code, retryable: error.retryable, final },
    });
    return 'failed';
  }

  private move(
    message: OutboundRecord,
    lease: Date,
    to: OutboundStatus,
    patch: OutboundPatch,
    detail: string | null,
  ) {
    assertTransition('sending', to);
    return this.messages.transition(
      message.organizationId,
      message.id,
      ['sending'],
      to,
      patch,
      { at: this.clock.now().toISOString(), status: to, detail },
      lease,
    );
  }
}

const ref = (message: OutboundRecord) => ({
  messageId: message.id,
  businessId: message.businessId,
  contactId: message.contactId,
  threadId: message.threadId,
  mailboxId: message.mailboxId,
});

const describe = (error: unknown) => (error instanceof Error ? error.message.slice(0, 300) : 'Send failed');

const retryable = (code: string, message: string, at: Date): OutboundError => ({
  code,
  message: message.slice(0, 500),
  retryable: true,
  at: at.toISOString(),
});

const permanent = (code: string, message: string, at: Date): OutboundError => ({
  code,
  message: message.slice(0, 500),
  retryable: false,
  at: at.toISOString(),
});

/** The provider may or may not have sent it, and cannot tell: never resent automatically. */
const unknownOutcome = (at: Date) =>
  permanent(
    'unknown_outcome',
    'The send may have gone out; check the mailbox’s Sent folder before retrying.',
    at,
  );
