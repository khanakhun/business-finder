import { type DbClient, getExecutor } from '@bf/db';
import { businesses, emailThreads, mailboxes, manualContactLogs, outboundMessages } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, lt, lte, or, type SQL, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';
import type {
  ManualLogRecord,
  OutboundListFilter,
  OutboundListRow,
  OutboundRecord,
  OutboundRepository,
  ThreadRecord,
} from '../../application/outbound/ports.ts';

const listColumns = {
  message: outboundMessages,
  businessName: businesses.displayName,
  mailboxEmail: mailboxes.email,
};

const toListRow = (row: {
  message: typeof outboundMessages.$inferSelect;
  businessName: string | null;
  mailboxEmail: string | null;
}): OutboundListRow => ({
  ...(row.message as OutboundRecord),
  businessName: row.businessName ?? '',
  mailboxEmail: row.mailboxEmail,
});

@Injectable()
export class DrizzleOutboundRepository implements OutboundRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private get x() {
    return getExecutor(this.db);
  }

  async byIdempotencyKey(organizationId: string, key: string) {
    const [row] = await this.x
      .select()
      .from(outboundMessages)
      .where(
        and(eq(outboundMessages.organizationId, organizationId), eq(outboundMessages.idempotencyKey, key)),
      );
    return row as OutboundRecord | undefined;
  }

  async get(organizationId: string, id: string) {
    const [row] = await this.x
      .select()
      .from(outboundMessages)
      .where(and(eq(outboundMessages.organizationId, organizationId), eq(outboundMessages.id, id)));
    return row as OutboundRecord | undefined;
  }

  async insert(row: Parameters<OutboundRepository['insert']>[0]) {
    const [stored] = await this.x.insert(outboundMessages).values(row).returning();
    if (!stored) throw new Error('outbound message not stored');
    return stored as OutboundRecord;
  }

  async transition(
    organizationId: string,
    id: string,
    from: Parameters<OutboundRepository['transition']>[2],
    to: Parameters<OutboundRepository['transition']>[3],
    patch: Parameters<OutboundRepository['transition']>[4],
    entry: Parameters<OutboundRepository['transition']>[5],
  ) {
    const [row] = await this.x
      .update(outboundMessages)
      .set({
        ...patch,
        status: to,
        statusHistory: sql`${outboundMessages.statusHistory} || ${JSON.stringify([entry])}::jsonb`,
      })
      .where(
        and(
          eq(outboundMessages.organizationId, organizationId),
          eq(outboundMessages.id, id),
          inArray(outboundMessages.status, [...from]),
        ),
      )
      .returning();
    return row as OutboundRecord | undefined;
  }

  private listQuery(where: SQL | undefined, limit: number) {
    return this.x
      .select(listColumns)
      .from(outboundMessages)
      .innerJoin(businesses, eq(businesses.id, outboundMessages.businessId))
      .leftJoin(mailboxes, eq(mailboxes.id, outboundMessages.mailboxId))
      .where(where)
      .orderBy(desc(outboundMessages.createdAt), desc(outboundMessages.id))
      .limit(limit);
  }

  async list(organizationId: string, filter: OutboundListFilter) {
    const conditions = [
      eq(outboundMessages.organizationId, organizationId),
      filter.statuses?.length ? inArray(outboundMessages.status, [...filter.statuses]) : undefined,
      filter.mailboxId ? eq(outboundMessages.mailboxId, filter.mailboxId) : undefined,
      filter.businessId ? eq(outboundMessages.businessId, filter.businessId) : undefined,
      filter.from ? gte(outboundMessages.createdAt, filter.from) : undefined,
      filter.to ? lte(outboundMessages.createdAt, filter.to) : undefined,
      filter.before
        ? or(
            lt(outboundMessages.createdAt, filter.before.createdAt),
            and(
              eq(outboundMessages.createdAt, filter.before.createdAt),
              lt(outboundMessages.id, filter.before.id),
            ),
          )
        : undefined,
    ];
    return (await this.listQuery(and(...conditions), filter.limit)).map(toListRow);
  }

  async listRow(organizationId: string, id: string) {
    const [row] = await this.listQuery(
      and(eq(outboundMessages.organizationId, organizationId), eq(outboundMessages.id, id)),
      1,
    );
    return row ? toListRow(row) : undefined;
  }

  async forBusiness(organizationId: string, businessId: string, limit: number) {
    return (
      await this.listQuery(
        and(eq(outboundMessages.organizationId, organizationId), eq(outboundMessages.businessId, businessId)),
        limit,
      )
    ).map(toListRow);
  }

  async insertThread(row: Parameters<OutboundRepository['insertThread']>[0]) {
    const [stored] = await this.x.insert(emailThreads).values(row).returning();
    if (!stored) throw new Error('email thread not stored');
    return stored as ThreadRecord;
  }

  async openThread(organizationId: string, businessId: string, contactId: string | null) {
    const [row] = await this.x
      .select()
      .from(emailThreads)
      .where(
        and(
          eq(emailThreads.organizationId, organizationId),
          eq(emailThreads.businessId, businessId),
          contactId ? eq(emailThreads.contactId, contactId) : isNull(emailThreads.contactId),
          eq(emailThreads.status, 'open'),
        ),
      )
      .orderBy(desc(emailThreads.lastMessageAt))
      .limit(1);
    return row as ThreadRecord | undefined;
  }

  async lastSent(threadId: string) {
    const [row] = await this.x
      .select()
      .from(outboundMessages)
      .where(and(eq(outboundMessages.threadId, threadId), eq(outboundMessages.status, 'sent')))
      .orderBy(desc(outboundMessages.sentAt))
      .limit(1);
    return row as OutboundRecord | undefined;
  }

  async touchThread(threadId: string, at: Date) {
    await this.x.update(emailThreads).set({ lastMessageAt: at }).where(eq(emailThreads.id, threadId));
  }

  async insertManualLog(row: Parameters<OutboundRepository['insertManualLog']>[0]) {
    const [stored] = await this.x.insert(manualContactLogs).values(row).returning();
    if (!stored) throw new Error('manual contact log not stored');
    return stored as ManualLogRecord;
  }

  async manualLogs(organizationId: string, businessId: string, limit: number) {
    return (await this.x
      .select()
      .from(manualContactLogs)
      .where(
        and(
          eq(manualContactLogs.organizationId, organizationId),
          eq(manualContactLogs.businessId, businessId),
        ),
      )
      .orderBy(desc(manualContactLogs.createdAt))
      .limit(limit)) as ManualLogRecord[];
  }
}
