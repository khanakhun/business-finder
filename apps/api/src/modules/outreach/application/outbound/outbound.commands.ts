import {
  type Clock,
  ConflictError,
  NotFoundError,
  newId,
  type OutboundStatus,
  OutreachMessageCancelled,
  OutreachMessageQueued,
  RescheduleMessageRequestSchema,
  type SendMessageRequest,
  SendMessageRequestSchema,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { ComplianceService, UnsubscribeService } from '../../../compliance/index.ts';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { Transactional } from '../../../platform/db/transactional.ts';
import { EventRecorder } from '../../../platform/events/event-recorder.ts';
import { MessageNotSendableError } from '../../domain/outbound/errors.ts';
import {
  type AllowedDecisionId,
  allowedDecision,
  MAX_SEND_ATTEMPTS,
  rfc822MessageId,
  scheduledAt,
} from '../../domain/outbound/outbound-message.ts';
import { assertTransition, CANCELLABLE } from '../../domain/outbound/state-machine.ts';
import { type DraftActor, DraftsService } from '../drafting/drafts.service.ts';
import type { StoredDraft } from '../drafting/ports.ts';
import { MailboxCapacity } from '../mailbox/mailbox-capacity.ts';
import { MAILBOX_REPOSITORY, type MailboxRecord, type MailboxRepository } from '../mailbox/ports.ts';
import {
  OUTBOUND_REPOSITORY,
  OUTBOUND_SETTINGS,
  OUTREACH_TOKENS,
  type OutboundRecord,
  type OutboundRepository,
  type OutboundSettings,
  type OutreachTokens,
  type ThreadRecord,
} from './ports.ts';

// One-click send (BF-052). The enqueue-stage compliance decision is evaluated and persisted first (a refusal is kept
// as evidence too); only an allowing decision lets the message be composed — with a real unsubscribe token (fail
// closed: no token, no message), the shared footer and the RFC 8058 headers — and queued after the undo window.
// Nothing here talks to a mailbox: the scheduler and the send worker do, after re-evaluating at send time.

@Injectable()
export class OutboundCommands {
  constructor(
    @Inject(OUTBOUND_REPOSITORY) private readonly messages: OutboundRepository,
    @Inject(MAILBOX_REPOSITORY) private readonly mailboxes: MailboxRepository,
    @Inject(OUTREACH_TOKENS) private readonly tokens: OutreachTokens,
    @Inject(OUTBOUND_SETTINGS) private readonly settings: OutboundSettings,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly drafts: DraftsService,
    private readonly compliance: ComplianceService,
    private readonly unsubscribe: UnsubscribeService,
    private readonly capacity: MailboxCapacity,
    private readonly events: EventRecorder,
  ) {}

  /** Queues a draft (or returns the message an earlier call with the same key queued). */
  async send(
    actor: DraftActor,
    input: SendMessageRequest,
    idempotencyKey: string,
  ): Promise<{ message: OutboundRecord; created: boolean }> {
    const request = SendMessageRequestSchema.parse(input);
    const existing = await this.messages.byIdempotencyKey(actor.organizationId, idempotencyKey);
    if (existing) {
      if (existing.draftId !== request.draftId)
        throw new ConflictError('This Idempotency-Key was used for another message.', {
          details: { reason: 'IDEMPOTENCY_KEY_REUSED' },
        });
      return { message: existing, created: false };
    }
    const draft = await this.drafts.draft(actor, request.draftId);
    if (draft.status !== 'draft')
      throw new MessageNotSendableError('This draft was already sent or discarded.', 'DRAFT_NOT_OPEN');
    if (draft.lint.some((issue) => issue.severity === 'error'))
      throw new MessageNotSendableError('Fix the draft’s errors before sending.', 'DRAFT_HAS_ERRORS');
    const subject =
      request.subjectVariantIndex === undefined
        ? draft.subject
        : draft.subjectVariants[request.subjectVariantIndex];
    if (!subject)
      throw new ValidationError('No such subject variant.', [
        { path: ['subjectVariantIndex'], message: 'Out of range' },
      ]);
    if (request.sendMode === 'schedule' && !request.scheduleAt)
      throw new ValidationError('A scheduled send needs a time.', [
        { path: ['scheduleAt'], message: 'Required' },
      ]);
    // Persisted before anything else, allowed or not (a refusal throws the typed 409/422 here).
    const decision = await this.compliance.evaluate(
      {
        organizationId: actor.organizationId,
        businessId: draft.businessId,
        ...(draft.contactId ? { contactId: draft.contactId } : {}),
      },
      'email',
      { purpose: draft.offer, stage: 'enqueue' },
    );
    const decisionId = allowedDecision(decision);
    return this.enqueue(actor, draft, {
      decisionId,
      decision,
      subject,
      mailboxId: request.mailboxId,
      requestedAt:
        request.sendMode === 'schedule' && request.scheduleAt ? new Date(request.scheduleAt) : null,
      idempotencyKey,
    });
  }

  @Transactional()
  private async enqueue(
    actor: DraftActor,
    draft: StoredDraft,
    input: {
      readonly decisionId: AllowedDecisionId;
      readonly decision: Parameters<DraftsService['compose']>[2]['decision'];
      readonly subject: string;
      readonly mailboxId: string | undefined;
      readonly requestedAt: Date | null;
      readonly idempotencyKey: string;
    },
  ): Promise<{ message: OutboundRecord; created: boolean }> {
    const now = this.clock.now();
    const id = newId();
    const thread =
      draft.purpose === 'first_touch'
        ? undefined
        : await this.messages.openThread(actor.organizationId, draft.businessId, draft.contactId);
    const { mailbox, notBefore } = await this.mailboxFor(actor, draft, input.mailboxId ?? thread?.mailboxId);
    const outreachToken = this.tokens.sign(id);
    const contact = await this.drafts.recipient(draft);
    if (!contact)
      throw new MessageNotSendableError('The business has no email address to send to.', 'NO_RECIPIENT');
    // Fail closed: `issue` throws when the token cannot be stored, and nothing is queued.
    const unsubscribe = await this.unsubscribe.issue(actor.organizationId, {
      contactId: contact.id,
      email: contact.email,
      businessId: draft.businessId,
      outboundMessageId: id,
      locale: draft.locale,
    });
    const composed = await this.drafts.compose(actor, draft, {
      decision: input.decision,
      unsubscribeUrl: unsubscribe.pageUrl,
      subject: input.subject,
      mailboxId: mailbox.id,
      outreachToken,
    });
    // Rolls the token back with the transaction.
    const blocking = composed.issues.find((issue) => issue.severity === 'error');
    if (blocking) throw new MessageNotSendableError(blocking.message, 'MISSING_IDENTITY');
    const messageId = rfc822MessageId(id, mailbox.email);
    const previous = thread ? await this.messages.lastSent(thread.id) : undefined;
    const references = [thread?.rootMessageId, previous?.rfc822MessageId].filter(
      (value, index, all): value is string => !!value && all.indexOf(value) === index,
    );
    const headers: Record<string, string> = {
      'Message-ID': messageId,
      'X-BF-Outbound-Id': id,
      'List-Unsubscribe': unsubscribe.mailtoUrl
        ? `<${unsubscribe.oneClickUrl}>, <${unsubscribe.mailtoUrl}>`
        : `<${unsubscribe.oneClickUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      ...(previous ? { 'In-Reply-To': previous.rfc822MessageId } : {}),
      ...(references.length > 0 ? { References: references.join(' ') } : {}),
    };
    const threadRow: ThreadRecord =
      thread ??
      (await this.messages.insertThread({
        id: newId(),
        organizationId: actor.organizationId,
        businessId: draft.businessId,
        contactId: contact.id,
        mailboxId: mailbox.id,
        subjectRoot: input.subject,
        rootMessageId: messageId,
        providerThreadId: null,
      }));
    const when = scheduledAt(
      now,
      this.settings.undoWindowSeconds,
      [input.requestedAt, notBefore].reduce<Date | null>(
        (latest, value) => (value && (!latest || value > latest) ? value : latest),
        null,
      ),
    );
    const status: OutboundStatus = 'queued';
    assertTransition('draft', status);
    const message = await this.messages.insert({
      id,
      organizationId: actor.organizationId,
      businessId: draft.businessId,
      contactId: contact.id,
      threadId: threadRow.id,
      mailboxId: mailbox.id,
      draftId: draft.id,
      sequenceEnrollmentId: null,
      sequenceStep: null,
      bulkRunId: null,
      purpose: draft.purpose,
      offer: draft.offer,
      locale: draft.locale,
      toEmail: contact.email,
      subject: composed.rendered.subject,
      bodyText: composed.rendered.text,
      bodyHtml: composed.rendered.html,
      headers,
      unsubscribeTokenId: unsubscribe.id,
      outreachToken,
      enqueueDecisionId: input.decisionId,
      sendDecisionId: null,
      lawfulBasisId: null,
      footerVersion: 1,
      blockedReasons: [],
      status,
      scheduledAt: when,
      rfc822MessageId: messageId,
      providerThreadId: thread?.providerThreadId ?? null,
      inReplyTo: previous?.rfc822MessageId ?? null,
      statusHistory: [{ at: now.toISOString(), status, detail: null }],
      idempotencyKey: input.idempotencyKey,
      createdBy: actor.userId,
      approvedBy: null,
      approvedAt: null,
    });
    await this.drafts.markSent(actor, draft.id);
    await this.events.record(OutreachMessageQueued, {
      orgId: actor.organizationId,
      payload: {
        messageId: id,
        businessId: draft.businessId,
        contactId: contact.id,
        threadId: threadRow.id,
        mailboxId: mailbox.id,
        scheduledAt: when.toISOString(),
        decisionId: input.decisionId,
      },
    });
    return { message, created: true };
  }

  /** The undo toast and the outbox: stops a message before it is sent. */
  @Transactional()
  async cancel(actor: DraftActor, id: string): Promise<OutboundRecord> {
    const message = await this.load(actor, id);
    assertTransition(message.status, 'cancelled');
    const now = this.clock.now();
    const moved = await this.messages.transition(
      actor.organizationId,
      id,
      CANCELLABLE,
      'cancelled',
      {},
      { at: now.toISOString(), status: 'cancelled', detail: actor.userId ? 'by a person' : null },
    );
    if (!moved)
      throw new ConflictError('The message is already on its way.', { details: { reason: 'TOO_LATE' } });
    if (message.draftId) await this.drafts.reopen(actor, message.draftId);
    await this.events.record(OutreachMessageCancelled, {
      orgId: actor.organizationId,
      payload: {
        messageId: id,
        businessId: message.businessId,
        contactId: message.contactId,
        threadId: message.threadId,
        mailboxId: message.mailboxId,
      },
    });
    return moved;
  }

  async reschedule(actor: DraftActor, id: string, input: unknown): Promise<OutboundRecord> {
    const { scheduledAt: at } = RescheduleMessageRequestSchema.parse(input);
    const message = await this.load(actor, id);
    const now = this.clock.now();
    const when = scheduledAt(now, 0, new Date(at));
    const moved = await this.messages.transition(
      actor.organizationId,
      id,
      ['queued'],
      'queued',
      { scheduledAt: when },
      { at: now.toISOString(), status: 'queued', detail: `rescheduled to ${when.toISOString()}` },
    );
    if (!moved)
      throw new ConflictError(`A ${message.status} message cannot be rescheduled.`, {
        details: { reason: 'NOT_QUEUED' },
      });
    return moved;
  }

  /** A failed message goes back to the queue (its attempts are kept; at most three). */
  async retry(actor: DraftActor, id: string): Promise<OutboundRecord> {
    const message = await this.load(actor, id);
    assertTransition(message.status, 'queued');
    if (message.attempts >= MAX_SEND_ATTEMPTS || message.lastError?.retryable === false)
      throw new ConflictError('This message cannot be retried.', { details: { reason: 'NO_ATTEMPTS_LEFT' } });
    const now = this.clock.now();
    const moved = await this.messages.transition(
      actor.organizationId,
      id,
      ['failed'],
      'queued',
      { scheduledAt: now, leaseUntil: null },
      { at: now.toISOString(), status: 'queued', detail: 'retry' },
    );
    if (!moved) throw new ConflictError('The message changed meanwhile.', { details: { reason: 'CHANGED' } });
    return moved;
  }

  private async load(actor: DraftActor, id: string) {
    const message = await this.messages.get(actor.organizationId, id);
    if (!message) throw new NotFoundError('OutboundMessage', id);
    return message;
  }

  /**
   * The sender: the one asked for, the thread's or the draft's, else the selector's choice. A full or closed
   * mailbox still takes the message (the worker sends it at its next slot); no mailbox at all stops the send.
   */
  private async mailboxFor(
    actor: DraftActor,
    draft: StoredDraft,
    wanted: string | null | undefined,
  ): Promise<{ mailbox: MailboxRecord; notBefore: Date | null }> {
    const id = wanted ?? draft.mailboxId;
    if (id) {
      const mailbox = await this.mailboxes.find(actor.organizationId, id);
      if (!mailbox || mailbox.disconnectedAt)
        throw new MessageNotSendableError('That mailbox is not connected.', 'MAILBOX_UNAVAILABLE');
      return { mailbox, notBefore: null };
    }
    const choice = await this.capacity.select({
      organizationId: actor.organizationId,
      stickyMailboxId: null,
      recipientLocale: draft.locale,
      recipientTimeZone: null,
    });
    if (choice.ok) {
      const mailbox = await this.mailboxes.find(actor.organizationId, choice.mailboxId);
      if (mailbox) return { mailbox, notBefore: new Date(choice.sendAt) };
    }
    const connected = (await this.mailboxes.list(actor.organizationId)).filter((m) => !m.disconnectedAt);
    const fallback = connected[0];
    if (!fallback) throw new MessageNotSendableError('Connect a mailbox to send email.', 'NO_MAILBOX');
    const nextAvailableAt = !choice.ok && choice.nextAvailableAt ? new Date(choice.nextAvailableAt) : null;
    return { mailbox: fallback, notBefore: nextAvailableAt };
  }
}
