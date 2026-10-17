import type { Locale, MailboxStatus } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { mailboxDailyUsage, mailboxEvents, mailboxes } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, gte, isNull, lte, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';
import type {
  MailboxEventRow,
  MailboxPatch,
  MailboxRecord,
  MailboxRepository,
  MailboxUsageRow,
  NewMailbox,
} from '../../application/mailbox/ports.ts';

type Row = typeof mailboxes.$inferSelect;

const toRecord = (row: Row): MailboxRecord => ({ ...row, locales: row.locales as Locale[] });

@Injectable()
export class DrizzleMailboxesRepository implements MailboxRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async list(organizationId: string) {
    const rows = await getExecutor(this.db)
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.organizationId, organizationId))
      .orderBy(asc(mailboxes.email));
    return rows.map(toRecord);
  }

  async find(organizationId: string, id: string) {
    const [row] = await getExecutor(this.db)
      .select()
      .from(mailboxes)
      .where(and(eq(mailboxes.organizationId, organizationId), eq(mailboxes.id, id)));
    return row ? toRecord(row) : undefined;
  }

  async findByEmail(organizationId: string, email: string) {
    const [row] = await getExecutor(this.db)
      .select()
      .from(mailboxes)
      .where(and(eq(mailboxes.organizationId, organizationId), eq(mailboxes.email, email)));
    return row ? toRecord(row) : undefined;
  }

  async insert(mailbox: NewMailbox) {
    const [row] = await getExecutor(this.db).insert(mailboxes).values(mailbox).returning();
    if (!row) throw new Error('mailbox insert returned no row');
    return toRecord(row);
  }

  async update(organizationId: string, id: string, patch: MailboxPatch) {
    const [row] = await getExecutor(this.db)
      .update(mailboxes)
      .set(patch)
      .where(and(eq(mailboxes.organizationId, organizationId), eq(mailboxes.id, id)))
      .returning();
    if (!row) throw new Error('mailbox update matched no row');
    return toRecord(row);
  }

  async setStatus(
    organizationId: string,
    id: string,
    from: MailboxStatus,
    to: MailboxStatus,
    reason: string | null,
  ) {
    const updated = await getExecutor(this.db)
      .update(mailboxes)
      .set({ status: to, statusReason: reason })
      .where(
        and(eq(mailboxes.organizationId, organizationId), eq(mailboxes.id, id), eq(mailboxes.status, from)),
      )
      .returning({ id: mailboxes.id });
    return updated.length > 0;
  }

  async addEvent(
    organizationId: string,
    mailboxId: string,
    event: Omit<MailboxEventRow, 'id' | 'createdAt'>,
  ) {
    await getExecutor(this.db)
      .insert(mailboxEvents)
      .values({ organizationId, mailboxId, ...event });
  }

  async events(organizationId: string, mailboxId: string, limit: number) {
    return getExecutor(this.db)
      .select({
        id: mailboxEvents.id,
        kind: mailboxEvents.kind,
        fromStatus: mailboxEvents.fromStatus,
        toStatus: mailboxEvents.toStatus,
        detail: mailboxEvents.detail,
        actorUserId: mailboxEvents.actorUserId,
        createdAt: mailboxEvents.createdAt,
      })
      .from(mailboxEvents)
      .where(and(eq(mailboxEvents.organizationId, organizationId), eq(mailboxEvents.mailboxId, mailboxId)))
      .orderBy(desc(mailboxEvents.createdAt))
      .limit(limit);
  }

  async usage(mailboxId: string, fromDay: string, toDay: string): Promise<MailboxUsageRow[]> {
    return getExecutor(this.db)
      .select({
        day: mailboxDailyUsage.day,
        sent: mailboxDailyUsage.sent,
        failed: mailboxDailyUsage.failed,
        bounced: mailboxDailyUsage.bounced,
        complaints: mailboxDailyUsage.complaints,
        replies: mailboxDailyUsage.replies,
      })
      .from(mailboxDailyUsage)
      .where(
        and(
          eq(mailboxDailyUsage.mailboxId, mailboxId),
          gte(mailboxDailyUsage.day, fromDay),
          lte(mailboxDailyUsage.day, toDay),
        ),
      )
      .orderBy(asc(mailboxDailyUsage.day));
  }

  async addUsage(mailboxId: string, day: string, delta: Partial<Omit<MailboxUsageRow, 'day'>>) {
    const values = {
      sent: delta.sent ?? 0,
      failed: delta.failed ?? 0,
      bounced: delta.bounced ?? 0,
      complaints: delta.complaints ?? 0,
      replies: delta.replies ?? 0,
    };
    await getExecutor(this.db)
      .insert(mailboxDailyUsage)
      .values({ mailboxId, day, ...values })
      .onConflictDoUpdate({
        target: [mailboxDailyUsage.mailboxId, mailboxDailyUsage.day],
        set: {
          sent: sql`${mailboxDailyUsage.sent} + ${values.sent}`,
          failed: sql`${mailboxDailyUsage.failed} + ${values.failed}`,
          bounced: sql`${mailboxDailyUsage.bounced} + ${values.bounced}`,
          complaints: sql`${mailboxDailyUsage.complaints} + ${values.complaints}`,
          replies: sql`${mailboxDailyUsage.replies} + ${values.replies}`,
        },
      });
  }

  async bounceRates(organizationId: string, fromDay: string) {
    const rows = await getExecutor(this.db)
      .select({
        mailboxId: mailboxDailyUsage.mailboxId,
        sent: sql<number>`sum(${mailboxDailyUsage.sent})::int`,
        bounced: sql<number>`sum(${mailboxDailyUsage.bounced})::int`,
      })
      .from(mailboxDailyUsage)
      .innerJoin(mailboxes, eq(mailboxes.id, mailboxDailyUsage.mailboxId))
      .where(and(eq(mailboxes.organizationId, organizationId), gte(mailboxDailyUsage.day, fromDay)))
      .groupBy(mailboxDailyUsage.mailboxId);
    return new Map(rows.map((row) => [row.mailboxId, row.sent > 0 ? row.bounced / row.sent : 0]));
  }

  async listForHealth(limit: number, afterId?: string) {
    const rows = await getExecutor(this.db)
      .select()
      .from(mailboxes)
      .where(and(isNull(mailboxes.disconnectedAt), afterId ? gt(mailboxes.id, afterId) : undefined))
      .orderBy(asc(mailboxes.id))
      .limit(limit);
    return rows.map(toRecord);
  }

  async delete(organizationId: string, id: string) {
    const deleted = await getExecutor(this.db)
      .delete(mailboxes)
      .where(and(eq(mailboxes.organizationId, organizationId), eq(mailboxes.id, id)))
      .returning({ id: mailboxes.id });
    return deleted.length > 0;
  }
}
