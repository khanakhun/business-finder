import { type DbClient, getExecutor } from '@bf/db';
import {
  businessContacts,
  businesses,
  emailThreads,
  inboundMessages,
  mailboxes,
  mailboxSyncState,
  outboundMessages,
} from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';
import type {
  InboundRecord,
  InboundRepository,
  InboxFilter,
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

  private threadQuery(where: SQL | undefined, limit: number) {
    return this.x
      .select({
        threadId: emailThreads.id,
        businessId: emailThreads.businessId,
        businessName: businesses.displayName,
        contactEmail: businessContacts.value,
        mailboxId: emailThreads.mailboxId,
        mailboxEmail: mailboxes.email,
        subject: emailThreads.subjectRoot,
        lastInboundAt: emailThreads.lastInboundAt,
        lastMessageAt: emailThreads.lastMessageAt,
        unreadCount: emailThreads.unreadCount,
        latestClass: emailThreads.latestTriageClass,
      })
      .from(emailThreads)
      .innerJoin(businesses, eq(businesses.id, emailThreads.businessId))
      .leftJoin(mailboxes, eq(mailboxes.id, emailThreads.mailboxId))
      .leftJoin(businessContacts, eq(businessContacts.id, emailThreads.contactId))
      .where(where)
      .orderBy(desc(emailThreads.lastInboundAt), desc(emailThreads.id))
      .limit(limit);
  }

  async threads(organizationId: string, filter: InboxFilter) {
    const inThread = (condition: SQL) =>
      sql`exists (select 1 from ${inboundMessages} where ${inboundMessages.threadId} = ${emailThreads.id} and ${condition})`;
    const conditions = [
      eq(emailThreads.organizationId, organizationId),
      isNotNull(emailThreads.lastInboundAt),
      filter.triageClass ? eq(emailThreads.latestTriageClass, filter.triageClass) : undefined,
      filter.mailboxId ? eq(emailThreads.mailboxId, filter.mailboxId) : undefined,
      filter.unread ? gt(emailThreads.unreadCount, 0) : undefined,
      filter.needsHuman
        ? inThread(
            sql`${inboundMessages.triageStatus} = 'needs_human' and ${inboundMessages.status} <> 'handled'`,
          )
        : undefined,
      filter.assignedTo ? inThread(sql`${inboundMessages.assignedTo} = ${filter.assignedTo}`) : undefined,
      filter.status ? inThread(sql`${inboundMessages.status} = ${filter.status}`) : undefined,
      filter.q
        ? or(ilike(businesses.displayName, `%${filter.q}%`), ilike(emailThreads.subjectRoot, `%${filter.q}%`))
        : undefined,
      filter.before
        ? or(
            lt(emailThreads.lastInboundAt, filter.before.at),
            and(eq(emailThreads.lastInboundAt, filter.before.at), lt(emailThreads.id, filter.before.id)),
          )
        : undefined,
    ];
    return this.threadQuery(and(...conditions), filter.limit);
  }

  async thread(organizationId: string, threadId: string) {
    const [row] = await this.threadQuery(
      and(eq(emailThreads.organizationId, organizationId), eq(emailThreads.id, threadId)),
      1,
    );
    return row;
  }

  async latestInbound(threadIds: readonly string[]) {
    if (threadIds.length === 0) return new Map<string, InboundRecord>();
    const rows = await this.x
      .selectDistinctOn([inboundMessages.threadId])
      .from(inboundMessages)
      .where(inArray(inboundMessages.threadId, [...threadIds]))
      .orderBy(inboundMessages.threadId, desc(inboundMessages.receivedAt));
    return new Map(rows.map((row) => [row.threadId, row as InboundRecord]));
  }

  async needsHumanThreads(threadIds: readonly string[]) {
    if (threadIds.length === 0) return new Set<string>();
    const rows = await this.x
      .selectDistinct({ threadId: inboundMessages.threadId })
      .from(inboundMessages)
      .where(
        and(
          inArray(inboundMessages.threadId, [...threadIds]),
          eq(inboundMessages.triageStatus, 'needs_human'),
          ne(inboundMessages.status, 'handled'),
        ),
      );
    return new Set(rows.map((row) => row.threadId));
  }

  async inboundOfThread(organizationId: string, threadId: string) {
    return (await this.x
      .select()
      .from(inboundMessages)
      .where(and(eq(inboundMessages.organizationId, organizationId), eq(inboundMessages.threadId, threadId)))
      .orderBy(inboundMessages.receivedAt)) as InboundRecord[];
  }

  async unreadTotal(organizationId: string) {
    const [row] = await this.x
      .select({ n: sql<number>`coalesce(sum(${emailThreads.unreadCount}), 0)` })
      .from(emailThreads)
      .where(eq(emailThreads.organizationId, organizationId));
    return Number(row?.n ?? 0);
  }

  async recountUnread(threadId: string) {
    await this.x
      .update(emailThreads)
      .set({
        unreadCount: sql`(select count(*) from ${inboundMessages} where ${inboundMessages.threadId} = ${threadId} and ${inboundMessages.status} = 'new')`,
      })
      .where(eq(emailThreads.id, threadId));
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

  async triageContext(inboundId: string) {
    const [row] = await this.x
      .select({
        businessId: emailThreads.businessId,
        businessName: businesses.displayName,
        contactId: emailThreads.contactId,
        ourMessage: outboundMessages.bodyText,
        locale: outboundMessages.locale,
      })
      .from(inboundMessages)
      .innerJoin(emailThreads, eq(emailThreads.id, inboundMessages.threadId))
      .innerJoin(businesses, eq(businesses.id, emailThreads.businessId))
      .leftJoin(outboundMessages, eq(outboundMessages.id, inboundMessages.outboundMessageId))
      .where(eq(inboundMessages.id, inboundId));
    return row
      ? { ...row, ourMessage: (row.ourMessage ?? '').slice(0, 4_000), locale: row.locale ?? ('en' as const) }
      : undefined;
  }

  async setThreadClass(threadId: string, triageClass: string | null) {
    await this.x
      .update(emailThreads)
      .set({ latestTriageClass: triageClass })
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
