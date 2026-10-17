import {
  decodeCursor,
  encodeCursor,
  type ListOutboundMessagesQuery,
  NotFoundError,
  type OutboundMessage,
  type OutboundMessageList,
  type OutboundMessageSummary,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { ComplianceService } from '../../../compliance/index.ts';
import { maskAddress } from '../../domain/outbound/outbound-message.ts';
import { OUTBOUND_REPOSITORY, type OutboundListRow, type OutboundRepository } from './ports.ts';

// Reading the outbox (BF-052): lists with masked recipients, and one message with its rendered content, headers,
// both compliance decisions (with their explanations) and its status timeline.

const summary = (row: OutboundListRow): OutboundMessageSummary => ({
  id: row.id,
  businessId: row.businessId as never,
  businessName: row.businessName,
  contactId: row.contactId,
  recipient: maskAddress(row.toEmail),
  mailboxId: row.mailboxId,
  mailboxEmail: row.mailboxEmail,
  subject: row.subject,
  purpose: row.purpose,
  offer: row.offer,
  locale: row.locale,
  status: row.status,
  scheduledAt: row.scheduledAt.toISOString(),
  sentAt: row.sentAt?.toISOString() ?? null,
  attempts: row.attempts,
  lastError: row.lastError,
  blockedReasons: row.blockedReasons,
  createdAt: row.createdAt.toISOString(),
});

@Injectable()
export class OutboundQueries {
  constructor(
    @Inject(OUTBOUND_REPOSITORY) private readonly messages: OutboundRepository,
    private readonly compliance: ComplianceService,
  ) {}

  async list(organizationId: string, query: ListOutboundMessagesQuery): Promise<OutboundMessageList> {
    const after = query.cursor ? await decodeCursor(query.cursor) : undefined;
    const rows = await this.messages.list(organizationId, {
      statuses: query.status,
      mailboxId: query.mailboxId,
      businessId: query.businessId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      before: after ? { createdAt: new Date(String(after.sort[0])), id: after.id } : undefined,
      limit: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(summary),
      nextCursor:
        rows.length > query.limit && last
          ? await encodeCursor({ sort: [last.createdAt.toISOString()], id: last.id })
          : null,
    };
  }

  async forBusiness(organizationId: string, businessId: string): Promise<OutboundMessageSummary[]> {
    return (await this.messages.forBusiness(organizationId, businessId, 50)).map(summary);
  }

  /** A thread's messages that left (or are leaving), with their text: the inbox shows them beside the replies. */
  async forThread(organizationId: string, threadId: string) {
    return (await this.messages.forThread(organizationId, threadId)).map((row) => ({
      ...summary(row),
      bodyText: row.bodyText,
    }));
  }

  async get(organizationId: string, id: string): Promise<OutboundMessage> {
    const row = await this.messages.listRow(organizationId, id);
    if (!row) throw new NotFoundError('OutboundMessage', id);
    const ids = [row.enqueueDecisionId, row.sendDecisionId].filter((value): value is string => !!value);
    const decisions = await this.compliance.decisionsById(organizationId, ids);
    const byId = new Map(decisions.map((decision) => [decision.id, decision]));
    return {
      ...summary(row),
      threadId: row.threadId,
      draftId: row.draftId,
      recipientEmail: row.toEmail ?? '',
      bodyText: row.bodyText,
      bodyHtml: row.bodyHtml,
      headers: row.headers,
      rfc822MessageId: row.rfc822MessageId,
      providerMessageId: row.providerMessageId,
      enqueueDecision: (row.enqueueDecisionId && byId.get(row.enqueueDecisionId)) || null,
      sendDecision: (row.sendDecisionId && byId.get(row.sendDecisionId)) || null,
      timeline: row.statusHistory,
      createdBy: row.createdBy,
      approvedBy: row.approvedBy,
      approvedAt: row.approvedAt?.toISOString() ?? null,
    };
  }
}
