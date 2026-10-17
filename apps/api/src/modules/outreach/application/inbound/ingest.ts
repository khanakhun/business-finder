import {
  type Clock,
  type InboundKind,
  newId,
  OUTREACH_INBOX_CHANGED,
  OutreachMessageBounced,
  OutreachReplyReceived,
} from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { RecordEmailVerificationCommand } from '../../../business-graph/index.ts';
import { ComplianceService } from '../../../compliance/index.ts';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { Transactional } from '../../../platform/db/transactional.ts';
import { EventRecorder } from '../../../platform/events/event-recorder.ts';
import { RealtimePublisher } from '../../../realtime/index.ts';
import { detectAutoReply } from '../../domain/inbound/auto-reply-detector.ts';
import { parseDsn } from '../../domain/inbound/dsn-parser.ts';
import { stripQuotes } from '../../domain/inbound/quote-stripper.ts';
import { normalizeMessageId, normalizeSubject, relevance } from '../../domain/inbound/relevance-filter.ts';
import { detectUnsubscribe } from '../../domain/inbound/unsubscribe-detector.ts';
import { MailboxCapacity } from '../mailbox/mailbox-capacity.ts';
import type { MailboxRecord, RawInbound } from '../mailbox/ports.ts';
import { OUTBOUND_REPOSITORY, type OutboundRepository } from '../outbound/ports.ts';
import { inboundMetrics } from './inbound-metrics.ts';
import {
  HTML_SANITIZER,
  type HtmlSanitizer,
  INBOUND_QUEUES,
  INBOUND_REPOSITORY,
  INBOUND_SETTINGS,
  type InboundQueues,
  type InboundRecord,
  type InboundRepository,
  type InboundSettings,
  MAIL_PARSER,
  type MailParser,
  type OutboundRef,
  type ParsedMail,
} from './ports.ts';

// Reply ingestion (BF-054, Pipes and Filters): parse in memory → privacy filter (irrelevant mail is dropped and only
// counted) → classify deterministically (bounce, automatic reply, unsubscribe mailto, human) → store sanitized →
// effects. A human reply emits `outreach.reply.received` before any model runs (sequences stop at once) and the
// outbound message becomes `replied`; an unsubscribe wording suppresses the address right away, triage or not; a
// hard bounce (or a third soft one in 7 days) marks the message bounced, the address invalid and suppressed.

const MAX_BODY = 100 * 1024;
const RECENT_DAYS = 60;
const SOFT_BOUNCE_WINDOW_DAYS = 7;

export type IngestOutcome = 'stored' | 'ignored' | 'duplicate';

@Injectable()
export class ReplyIngestion {
  constructor(
    @Inject(INBOUND_REPOSITORY) private readonly inbound: InboundRepository,
    @Inject(OUTBOUND_REPOSITORY) private readonly outbound: OutboundRepository,
    @Inject(MAIL_PARSER) private readonly parser: MailParser,
    @Inject(HTML_SANITIZER) private readonly sanitizer: HtmlSanitizer,
    @Inject(INBOUND_QUEUES) private readonly queues: InboundQueues,
    @Inject(INBOUND_SETTINGS) private readonly settings: InboundSettings,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly compliance: ComplianceService,
    private readonly verification: RecordEmailVerificationCommand,
    private readonly capacity: MailboxCapacity,
    private readonly events: EventRecorder,
    private readonly realtime: RealtimePublisher,
  ) {}

  async ingest(mailbox: MailboxRecord, message: RawInbound, logger: Logger): Promise<IngestOutcome> {
    if (!message.raw) {
      inboundMetrics.ignored().inc({ reason: 'no_source' });
      return 'ignored';
    }
    const mail = await this.parser.parse(message.raw);
    const dsn = parseDsn({
      contentType: mail.contentType,
      fromEmail: mail.from?.email ?? null,
      subject: mail.subject,
      text: mail.text,
      parts: mail.parts,
    });
    const references = [mail.inReplyTo, ...mail.references]
      .filter((value): value is string => !!value)
      .map(normalizeMessageId);
    const bounced = dsn?.originalMessageId ? [normalizeMessageId(dsn.originalMessageId)] : [];
    const ours = await this.inbound.outboundByMessageIds(mailbox.organizationId, [...references, ...bounced]);
    const threads = message.providerThreadId
      ? await this.inbound.threadsByProviderId(mailbox.organizationId, [message.providerThreadId])
      : [];
    const recent =
      mail.from && !dsn
        ? await this.inbound.recentlyEmailed(
            mailbox.id,
            mail.from.email,
            new Date(this.clock.now().getTime() - RECENT_DAYS * 86_400_000),
          )
        : [];
    const verdict = relevance(
      {
        fromEmail: mail.from?.email ?? null,
        to: mail.to,
        subject: mail.subject,
        references,
        providerThreadId: message.providerThreadId,
        bouncedMessageIds: bounced,
      },
      {
        ourMessageIds: new Set(ours.map((row) => normalizeMessageId(row.rfc822MessageId))),
        ourProviderThreads: new Set(threads.map((thread) => thread.providerThreadId)),
        unsubscribeMailto: this.settings.unsubscribeMailto,
        recentContacts: new Map(
          mail.from ? [[mail.from.email, recent.map((row) => normalizeSubject(row.subject))]] : [],
        ),
      },
    );
    // Privacy: anything else in the partner's mailbox leaves no trace but a counter.
    if (!verdict.relevant) {
      inboundMetrics.ignored().inc({ reason: 'not_outreach' });
      return 'ignored';
    }
    const parent =
      (verdict.messageId &&
        ours.find((row) => normalizeMessageId(row.rfc822MessageId) === verdict.messageId)) ||
      (verdict.reason === 'thread' && threads[0]
        ? await this.inbound.latestOutbound(threads[0].id)
        : undefined) ||
      (verdict.reason === 'contact_subject'
        ? recent.find((row) => normalizeSubject(row.subject) === normalizeSubject(mail.subject))
        : undefined) ||
      (verdict.reason === 'unsubscribe_mailto' ? recent[0] : undefined);
    if (!parent) {
      inboundMetrics.ignored().inc({ reason: 'no_thread' });
      return 'ignored';
    }
    const receivedAt = message.receivedAt ?? mail.date ?? this.clock.now();
    const autoReply = dsn
      ? null
      : detectAutoReply({ headers: mail.headers, subject: mail.subject, text: mail.text, receivedAt });
    const kind: InboundKind = dsn
      ? 'bounce'
      : verdict.reason === 'unsubscribe_mailto'
        ? 'unsubscribe_mailto'
        : autoReply
          ? 'auto_reply'
          : 'human';
    const stored = await this.store(mailbox, message, mail, parent, {
      kind,
      dsn,
      autoReplyUntil: autoReply?.returnDate ?? null,
      receivedAt,
    });
    if (!stored) return 'duplicate';
    inboundMetrics.ingested().inc({ kind });
    inboundMetrics.lag().observe(Math.max(0, (this.clock.now().getTime() - receivedAt.getTime()) / 1000));
    await this.realtime
      .publish(stored.organizationId, {
        type: OUTREACH_INBOX_CHANGED,
        entity: 'email_thread',
        entityId: stored.threadId,
        payload: { threadId: stored.threadId, businessId: parent.businessId },
      })
      .catch((error: unknown) => logger.warn({ err: error }, 'inbox realtime publish failed'));
    if (stored.kind === 'human') await this.queues.triage(stored.organizationId, stored.id);
    return 'stored';
  }

  @Transactional()
  private async store(
    mailbox: MailboxRecord,
    message: RawInbound,
    mail: ParsedMail,
    parent: OutboundRef,
    input: {
      readonly kind: InboundKind;
      readonly dsn: ReturnType<typeof parseDsn>;
      readonly autoReplyUntil: string | null;
      readonly receivedAt: Date;
    },
  ): Promise<InboundRecord | undefined> {
    const sanitized = mail.html ? this.sanitizer.sanitize(mail.html) : null;
    const text = (mail.text || (mail.html ? this.sanitizer.toText(mail.html) : '')).slice(0, MAX_BODY);
    const fresh = stripQuotes(text);
    const unsubscribe =
      input.kind === 'unsubscribe_mailto' ||
      (input.kind === 'human' && detectUnsubscribe(fresh, mail.subject).detected);
    const row = await this.inbound.insert({
      id: newId(),
      organizationId: mailbox.organizationId,
      mailboxId: mailbox.id,
      threadId: parent.threadId,
      outboundMessageId: parent.id,
      providerMessageId: message.providerMessageId,
      rfc822MessageId: mail.messageId,
      inReplyTo: mail.inReplyTo,
      references: mail.references,
      fromEmail: mail.from?.email ?? null,
      fromName: mail.from?.name ?? null,
      to: mail.to,
      cc: mail.cc,
      subject: mail.subject.slice(0, 500),
      receivedAt: input.receivedAt,
      bodyText: text,
      bodyHtmlSanitized: sanitized ? sanitized.html.slice(0, MAX_BODY) : null,
      hasRemoteImages: sanitized?.hasRemoteImages ?? false,
      snippet: (fresh || text).replace(/\s+/g, ' ').slice(0, 200),
      attachments: mail.parts
        .filter((part) => part.filename)
        .map((part) => ({ filename: part.filename, contentType: part.contentType, size: part.size })),
      kind: input.kind,
      dsn: input.dsn
        ? {
            action: input.dsn.action,
            status: input.dsn.status,
            permanent: input.dsn.permanent,
            recipient: input.dsn.recipient,
            diagnostic: input.dsn.diagnostic,
          }
        : null,
      autoReplyUntil: input.autoReplyUntil,
      unsubscribeDetected: unsubscribe,
    });
    if (!row) return undefined;
    if (input.kind === 'bounce') {
      await this.bounce(mailbox, row, parent);
      return row;
    }
    const now = this.clock.now();
    await this.inbound.touchThread(parent.threadId, input.receivedAt, { human: input.kind !== 'auto_reply' });
    if (input.kind !== 'auto_reply' && parent.status === 'sent')
      await this.outbound.transition(
        parent.organizationId,
        parent.id,
        ['sent'],
        'replied',
        {},
        { at: now.toISOString(), status: 'replied', detail: input.kind },
      );
    if (unsubscribe && row.fromEmail)
      await this.compliance.suppress({
        organizationId: mailbox.organizationId,
        scope: 'email',
        value: row.fromEmail,
        reason: 'unsubscribe',
        source: 'reply',
        actor: { type: 'system', id: 'outreach.reply' },
        note: `Reply ${row.id}`,
      });
    if (input.kind !== 'auto_reply') await this.capacity.record(mailbox, 'replies');
    await this.events.record(OutreachReplyReceived, {
      orgId: mailbox.organizationId,
      actor: { type: 'job', id: 'outreach.sync' },
      payload: {
        inboundId: row.id,
        threadId: row.threadId,
        businessId: parent.businessId as never,
        contactId: parent.contactId,
        outboundMessageId: parent.id,
        kind: input.kind,
        autoReplyUntil: input.autoReplyUntil,
      },
    });
    return row;
  }

  /** A hard bounce (or the third soft one in 7 days): bounced, invalid, suppressed. */
  private async bounce(mailbox: MailboxRecord, row: InboundRecord, parent: OutboundRef) {
    const dsn = row.dsn;
    const email = (dsn?.recipient ?? parent.toEmail ?? '').toLowerCase();
    const now = this.clock.now();
    await this.inbound.touchThread(parent.threadId, row.receivedAt, { human: false });
    let hard = dsn?.permanent ?? false;
    if (!hard && dsn?.action === 'failed' && email)
      hard =
        (await this.inbound.softBounces(
          mailbox.organizationId,
          email,
          new Date(now.getTime() - SOFT_BOUNCE_WINDOW_DAYS * 86_400_000),
        )) >= 3;
    if (!hard) return;
    if (parent.status === 'sent' || parent.status === 'replied')
      await this.outbound.transition(
        parent.organizationId,
        parent.id,
        ['sent'],
        'bounced',
        {},
        { at: now.toISOString(), status: 'bounced', detail: dsn?.status ?? 'hard bounce' },
      );
    await this.capacity.record(mailbox, 'bounced');
    if (email) {
      await this.compliance.suppress({
        organizationId: mailbox.organizationId,
        scope: 'email',
        value: email,
        reason: 'hard_bounce',
        source: 'system',
        actor: { type: 'system', id: 'outreach.bounce' },
        note: dsn?.status ? `Bounce ${dsn.status}` : 'Bounce',
      });
      await this.verification.execute(parent.businessId, email, {
        status: 'invalid',
        verifiedAt: now,
        details: {
          reachable: 'invalid',
          isCatchAll: null,
          isDisposable: null,
          isRoleAccount: null,
          mxAcceptsMail: null,
          smtpCanConnect: null,
          provider: null,
          checkedVia: 'bounce',
        },
      });
    }
    await this.events.record(OutreachMessageBounced, {
      orgId: mailbox.organizationId,
      actor: { type: 'job', id: 'outreach.sync' },
      payload: {
        messageId: parent.id,
        businessId: parent.businessId as never,
        contactId: parent.contactId,
        mailboxId: parent.mailboxId,
        permanent: true,
        status: dsn?.status ?? null,
      },
    });
  }
}
