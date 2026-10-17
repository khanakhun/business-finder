import {
  CorrectTriageRequestSchema,
  decodeCursor,
  type EmailDraft,
  encodeCursor,
  type InboundMessage,
  type InboxQuery,
  type InboxThread,
  type InboxThreadDetail,
  type InboxThreadList,
  NotFoundError,
  OUTREACH_INBOX_CHANGED,
  SuggestReplyRequestSchema,
  UpdateInboundRequestSchema,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { RealtimePublisher } from '../../../realtime/index.ts';
import type { DraftActor } from '../drafting/drafts.service.ts';
import { DraftsService } from '../drafting/drafts.service.ts';
import { OutboundQueries } from '../outbound/outbound.queries.ts';
import {
  INBOUND_REPOSITORY,
  type InboundRecord,
  type InboundRepository,
  type InboxThreadRow,
} from './ports.ts';
import { ReplyTriageService } from './triage.ts';

// The unified inbox (BF-054): outreach threads with a reply, filtered by triage class, mailbox, unread, needs a
// person, assigned to me; a thread with our messages and theirs in order (their HTML sanitized at ingestion);
// assign, snooze, mark handled; correct the triage (feedback; the policy runs again); and a suggested reply, drafted
// on demand with BF-051 (reply mode) and sent through BF-052 in the same thread.

const view = (row: InboundRecord): InboundMessage => ({
  id: row.id,
  threadId: row.threadId,
  mailboxId: row.mailboxId,
  outboundMessageId: row.outboundMessageId,
  fromEmail: row.fromEmail ?? '',
  fromName: row.fromName,
  subject: row.subject,
  receivedAt: row.receivedAt.toISOString(),
  snippet: row.snippet,
  bodyText: row.bodyText,
  bodyHtml: row.bodyHtmlSanitized,
  hasRemoteImages: row.hasRemoteImages,
  kind: row.kind,
  dsn: row.dsn,
  autoReplyUntil: row.autoReplyUntil,
  unsubscribeDetected: row.unsubscribeDetected,
  triage: row.triage,
  triageStatus: row.triageStatus,
  correctedClass: row.correctedClass,
  status: row.status,
  assignedTo: row.assignedTo,
  snoozedUntil: row.snoozedUntil?.toISOString() ?? null,
  attachments: row.attachments,
});

/** What to ask the drafting model for, by triage class (the reply's summary rides along as context). */
const REPLY_INTENT: Record<string, string> = {
  interested: 'They are interested: thank them and propose a short call with two time options.',
  question: 'They asked a question: answer it plainly from the facts, then propose a short call.',
  not_now: 'Not now: thank them, say you will follow up later, no pressure.',
  referral: 'They referred us to someone: thank them warmly; we will contact that person.',
  negative: 'They declined: thank them briefly and close politely, no further ask.',
};

@Injectable()
export class InboxService {
  constructor(
    @Inject(INBOUND_REPOSITORY) private readonly inbound: InboundRepository,
    private readonly triage: ReplyTriageService,
    private readonly drafts: DraftsService,
    private readonly outbound: OutboundQueries,
    private readonly realtime: RealtimePublisher,
  ) {}

  async list(actor: DraftActor, query: InboxQuery): Promise<InboxThreadList> {
    const after = query.cursor ? await decodeCursor(query.cursor) : undefined;
    const rows = await this.inbound.threads(actor.organizationId, {
      triageClass: query.class,
      mailboxId: query.mailboxId,
      unread: query.unread,
      needsHuman: query.needsHuman,
      assignedTo: query.assignedToMe ? (actor.userId ?? undefined) : undefined,
      status: query.status,
      q: query.q,
      before: after ? { at: new Date(String(after.sort[0])), id: after.id } : undefined,
      limit: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: await this.threads(page),
      nextCursor:
        rows.length > query.limit && last?.lastInboundAt
          ? await encodeCursor({ sort: [last.lastInboundAt.toISOString()], id: last.threadId })
          : null,
      unread: await this.inbound.unreadTotal(actor.organizationId),
    };
  }

  async detail(actor: DraftActor, threadId: string): Promise<InboxThreadDetail> {
    const row = await this.inbound.thread(actor.organizationId, threadId);
    if (!row) throw new NotFoundError('EmailThread', threadId);
    const [thread] = await this.threads([row]);
    const inbound = await this.inbound.inboundOfThread(actor.organizationId, threadId);
    const outbound = await this.outbound.forThread(actor.organizationId, threadId);
    const entries: InboxThreadDetail['entries'] = [
      ...outbound.map((message) => ({
        direction: 'outbound' as const,
        message,
        at: message.sentAt ?? message.createdAt,
      })),
      ...inbound.map((message) => ({
        direction: 'inbound' as const,
        message: view(message),
        at: message.receivedAt.toISOString(),
      })),
    ]
      .sort((a, b) => a.at.localeCompare(b.at))
      .map(({ at: _at, ...entry }) => entry);
    return { thread: thread as InboxThread, entries };
  }

  async update(actor: DraftActor, inboundId: string, input: unknown): Promise<InboundMessage> {
    const patch = UpdateInboundRequestSchema.parse(input);
    const row = await this.load(actor, inboundId);
    const updated = await this.inbound.update(row.id, {
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.assignedTo !== undefined ? { assignedTo: patch.assignedTo } : {}),
      ...(patch.snoozedUntil !== undefined
        ? { snoozedUntil: patch.snoozedUntil ? new Date(patch.snoozedUntil) : null }
        : {}),
    });
    await this.inbound.recountUnread(row.threadId);
    await this.changed(actor, row.threadId);
    return view(updated ?? row);
  }

  async correct(actor: DraftActor, inboundId: string, input: unknown): Promise<InboundMessage> {
    const request = CorrectTriageRequestSchema.parse(input);
    const row = await this.load(actor, inboundId);
    const updated = await this.triage.correct(row, request.class, actor.userId);
    await this.changed(actor, row.threadId);
    return view(updated);
  }

  /** A reply drafted for this message (BF-051 reply mode): the person edits it, then sends it in the thread. */
  async suggestReply(actor: DraftActor, inboundId: string, input: unknown): Promise<EmailDraft> {
    const request = SuggestReplyRequestSchema.parse(input);
    const row = await this.load(actor, inboundId);
    const thread = await this.inbound.thread(actor.organizationId, row.threadId);
    if (!thread) throw new NotFoundError('EmailThread', row.threadId);
    const parent = row.outboundMessageId
      ? await this.outbound.get(actor.organizationId, row.outboundMessageId)
      : null;
    const triageClass = row.correctedClass ?? row.triage?.class ?? 'question';
    const intent = REPLY_INTENT[triageClass] ?? REPLY_INTENT.question;
    const context = row.triage?.summary ? ` Their reply: ${row.triage.summary}` : '';
    return this.drafts.create(actor, {
      businessId: thread.businessId as never,
      contactId: parent?.contactId ?? null,
      offer: parent?.offer ?? 'website_redesign',
      purpose: 'reply',
      mode: 'ai',
      ...(request.locale ? { locale: request.locale } : parent ? { locale: parent.locale } : {}),
      ...(thread.mailboxId ? { mailboxId: thread.mailboxId } : {}),
      instructions: `${request.instructions ?? intent}${context}`.slice(0, 300),
    });
  }

  private async load(actor: DraftActor, inboundId: string) {
    const row = await this.inbound.get(actor.organizationId, inboundId);
    if (!row) throw new NotFoundError('InboundMessage', inboundId);
    return row;
  }

  private async changed(actor: DraftActor, threadId: string) {
    const thread = await this.inbound.thread(actor.organizationId, threadId);
    await this.realtime.publish(actor.organizationId, {
      type: OUTREACH_INBOX_CHANGED,
      entity: 'email_thread',
      entityId: threadId,
      payload: { threadId, businessId: thread?.businessId ?? null },
    });
  }

  private async threads(rows: readonly InboxThreadRow[]): Promise<InboxThread[]> {
    const ids = rows.map((row) => row.threadId);
    const latest = await this.inbound.latestInbound(ids);
    const needsHuman = await this.inbound.needsHumanThreads(ids);
    return rows.map((row) => {
      const message = latest.get(row.threadId);
      return {
        threadId: row.threadId,
        businessId: row.businessId as never,
        businessName: row.businessName,
        contactEmail: row.contactEmail,
        mailboxId: row.mailboxId,
        mailboxEmail: row.mailboxEmail,
        subject: row.subject,
        lastInboundAt: row.lastInboundAt?.toISOString() ?? null,
        lastMessageAt: row.lastMessageAt.toISOString(),
        unreadCount: row.unreadCount,
        latestClass: (message?.correctedClass ??
          message?.triage?.class ??
          null) as InboxThread['latestClass'],
        latestKind: message?.kind ?? null,
        needsHuman: needsHuman.has(row.threadId),
        snippet: message?.snippet ?? '',
        status: message?.status ?? 'new',
        assignedTo: message?.assignedTo ?? null,
      };
    });
  }
}
