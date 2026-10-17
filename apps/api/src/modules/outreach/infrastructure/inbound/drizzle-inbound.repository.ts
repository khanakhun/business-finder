import { type DbClient, getExecutor } from '@bf/db';
import { emailThreads, inboundMessages, mailboxes, mailboxSyncState, outboundMessages } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';
import type {
  InboundRecord,
  InboundRepository,
  OutboundRef,
  SyncState,
} from '../../application/inbound/ports.ts';

const refColumns = {
  id: outboundMessages.id,
  organizationId: outboundMessages.organizationId,
  businessId: outboundMessages.businessId,
  contactId: outboundMessages.contactId,
  threadId: outboundMessages.threadId,
  mailboxId: outboundMessages.mailboxId,
  status: outboundMessages.status,
  toEmail: outboundMessages.toEmail,
  rfc822MessageId: outboundMessages.rfc822MessageId,
};

@Injectable()
export class DrizzleInboundRepository implements InboundRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private get x() {
    return getExecutor(this.db);
  }

  async outboundByMessageIds(organizationId: string, messageIds: readonly string[]): Promise<OutboundRef[]> {
    if (messageIds.length === 0) return [];
    return this.x
      .select(refColumns)
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.organizationId, organizationId),
          inArray(sql`lower(${outboundMessages.rfc822MessageId})`, [...messageIds]),
        ),
      );
  }

  async threadsByProviderId(organizationId: string, providerThreadIds: readonly string[]) {
    if (providerThreadIds.length === 0) return [];
    const rows = await this.x
      .select({ id: emailThreads.id, providerThreadId: emailThreads.providerThreadId })
      .from(emailThreads)
      .where(
        and(
          eq(emailThreads.organizationId, organizationId),
          inArray(emailThreads.providerThreadId, [...providerThreadIds]),
        ),
      );
    return rows.flatMap((row) =>
      row.providerThreadId ? [{ id: row.id, providerThreadId: row.providerThreadId }] : [],
    );
  }

  async latestOutbound(threadId: string) {
    const [row] = await this.x
      .select(refColumns)
      .from(outboundMessages)
      .where(
        and(eq(outboundMessages.threadId, threadId), inArray(outboundMessages.status, ['sent', 'replied'])),
      )
      .orderBy(desc(outboundMessages.sentAt))
      .limit(1);
    return row;
  }

  async recentlyEmailed(mailboxId: string, email: string, since: Date) {
    return this.x
      .select({ ...refColumns, subject: emailThreads.subjectRoot })
      .from(outboundMessages)
      .innerJoin(emailThreads, eq(emailThreads.id, outboundMessages.threadId))
      .where(
        and(
          eq(outboundMessages.mailboxId, mailboxId),
          eq(sql`lower(${outboundMessages.toEmail})`, email.toLowerCase()),
          inArray(outboundMessages.status, ['sent', 'replied', 'bounced']),
          gte(outboundMessages.sentAt, since),
        ),
      )
      .orderBy(desc(outboundMessages.sentAt))
      .limit(20);
  }

  async insert(row: Parameters<InboundRepository['insert']>[0]) {
    const [stored] = await this.x.insert(inboundMessages).values(row).onConflictDoNothing().returning();
    return stored as InboundRecord | undefined;
  }

  async get(organizationId: string, id: string) {
    const [row] = await this.x
      .select()
      .from(inboundMessages)
      .where(and(eq(inboundMessages.organizationId, organizationId), eq(inboundMessages.id, id)));
    return row as InboundRecord | undefined;
  }

  async byId(id: string) {
    const [row] = await this.x.select().from(inboundMessages).where(eq(inboundMessages.id, id));
    return row as InboundRecord | undefined;
  }

  async update(id: string, patch: Parameters<InboundRepository['update']>[1]) {
    const [row] = await this.x
      .update(inboundMessages)
      .set(patch)
      .where(eq(inboundMessages.id, id))
      .returning();
    return row as InboundRecord | undefined;
  }

  async touchThread(threadId: string, at: Date, input: Parameters<InboundRepository['touchThread']>[2]) {
    await this.x
      .update(emailThreads)
      .set({
        lastInboundAt: at,
        lastMessageAt: sql`greatest(${emailThreads.lastMessageAt}, ${at.toISOString()}::timestamptz)`,
        unreadCount: sql`${emailThreads.unreadCount} + 1`,
        ...(input.human ? { status: 'replied' as const } : {}),
        ...(input.triageClass !== undefined ? { latestTriageClass: input.triageClass } : {}),
      })
      .where(eq(emailThreads.id, threadId));
  }

  async softBounces(organizationId: string, email: string, since: Date) {
    const [row] = await this.x
      .select({ n: count() })
      .from(inboundMessages)
      .where(
        and(
          eq(inboundMessages.organizationId, organizationId),
          eq(inboundMessages.kind, 'bounce'),
          gte(inboundMessages.receivedAt, since),
          sql`lower(${inboundMessages.dsn} ->> 'recipient') = ${email.toLowerCase()}`,
        ),
      );
    return Number(row?.n ?? 0);
  }

  async syncState(mailboxId: string) {
    const [row] = await this.x
      .select()
      .from(mailboxSyncState)
      .where(eq(mailboxSyncState.mailboxId, mailboxId));
    return row as SyncState | undefined;
  }

  async saveSync(
    mailboxId: string,
    organizationId: string,
    patch: Parameters<InboundRepository['saveSync']>[2],
  ) {
    const { ingested, ignored, ...rest } = patch;
    await this.x
      .insert(mailboxSyncState)
      .values({ mailboxId, organizationId, ...rest, ingested: ingested ?? 0, ignored: ignored ?? 0 })
      .onConflictDoUpdate({
        target: mailboxSyncState.mailboxId,
        set: {
          ...rest,
          ...(ingested !== undefined ? { ingested: sql`${mailboxSyncState.ingested} + ${ingested}` } : {}),
          ...(ignored !== undefined ? { ignored: sql`${mailboxSyncState.ignored} + ${ignored}` } : {}),
        },
      });
  }

  async dueMailboxes(now: Date, limit: number) {
    return this.x
      .select({ id: mailboxes.id, organizationId: mailboxes.organizationId })
      .from(mailboxes)
      .leftJoin(mailboxSyncState, eq(mailboxSyncState.mailboxId, mailboxes.id))
      .where(
        and(
          isNull(mailboxes.disconnectedAt),
          inArray(mailboxes.status, ['connected', 'warming', 'active', 'paused']),
          or(isNull(mailboxSyncState.mailboxId), lte(mailboxSyncState.nextPollAt, now)),
        ),
      )
      .limit(limit);
  }
}
