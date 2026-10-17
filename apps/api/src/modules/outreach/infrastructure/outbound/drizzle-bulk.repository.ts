import type { OutboundStatus } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { businesses, mailboxes, outboundMessages, outreachBulkRuns } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';
import type {
  BulkRepository,
  BulkRunRecord,
  OutboundListRow,
  OutboundRecord,
} from '../../application/outbound/ports.ts';

@Injectable()
export class DrizzleBulkRepository implements BulkRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private get x() {
    return getExecutor(this.db);
  }

  async insertRun(row: Parameters<BulkRepository['insertRun']>[0]) {
    const [stored] = await this.x.insert(outreachBulkRuns).values(row).returning();
    if (!stored) throw new Error('bulk run not stored');
    return stored as BulkRunRecord;
  }

  async run(organizationId: string | null, id: string) {
    const [row] = await this.x
      .select()
      .from(outreachBulkRuns)
      .where(
        and(
          eq(outreachBulkRuns.id, id),
          organizationId ? eq(outreachBulkRuns.organizationId, organizationId) : undefined,
        ),
      );
    return row as BulkRunRecord | undefined;
  }

  async runs(organizationId: string, limit: number) {
    return (await this.x
      .select()
      .from(outreachBulkRuns)
      .where(eq(outreachBulkRuns.organizationId, organizationId))
      .orderBy(desc(outreachBulkRuns.createdAt))
      .limit(limit)) as BulkRunRecord[];
  }

  async settle(id: string, outcome: Parameters<BulkRepository['settle']>[1]) {
    const total = sql`cardinality(${outreachBulkRuns.businessIds})`;
    const done = sql`${outreachBulkRuns.drafted} + jsonb_array_length(${outreachBulkRuns.skipped})`;
    const patch =
      'drafted' in outcome
        ? { drafted: sql`${outreachBulkRuns.drafted} + 1` }
        : { skipped: sql`${outreachBulkRuns.skipped} || ${JSON.stringify([outcome.skipped])}::jsonb` };
    await this.x.update(outreachBulkRuns).set(patch).where(eq(outreachBulkRuns.id, id));
    await this.x
      .update(outreachBulkRuns)
      .set({ status: 'ready' })
      .where(
        and(eq(outreachBulkRuns.id, id), eq(outreachBulkRuns.status, 'drafting'), sql`${done} >= ${total}`),
      );
  }

  async setStatus(id: string, status: BulkRunRecord['status']) {
    await this.x.update(outreachBulkRuns).set({ status }).where(eq(outreachBulkRuns.id, id));
  }

  async counts(runIds: readonly string[]) {
    const result = new Map<string, Partial<Record<OutboundStatus, number>>>();
    if (runIds.length === 0) return result;
    const rows = await this.x
      .select({ runId: outboundMessages.bulkRunId, status: outboundMessages.status, n: count() })
      .from(outboundMessages)
      .where(inArray(outboundMessages.bulkRunId, [...runIds]))
      .groupBy(outboundMessages.bulkRunId, outboundMessages.status);
    for (const row of rows) {
      if (!row.runId) continue;
      const entry = result.get(row.runId) ?? {};
      entry[row.status] = Number(row.n);
      result.set(row.runId, entry);
    }
    return result;
  }

  async messages(organizationId: string, runId: string): Promise<OutboundListRow[]> {
    const rows = await this.x
      .select({
        message: outboundMessages,
        businessName: businesses.displayName,
        mailboxEmail: mailboxes.email,
      })
      .from(outboundMessages)
      .innerJoin(businesses, eq(businesses.id, outboundMessages.businessId))
      .leftJoin(mailboxes, eq(mailboxes.id, outboundMessages.mailboxId))
      .where(and(eq(outboundMessages.organizationId, organizationId), eq(outboundMessages.bulkRunId, runId)))
      .orderBy(businesses.displayName);
    return rows.map((row) => ({
      ...(row.message as OutboundRecord),
      businessName: row.businessName,
      mailboxEmail: row.mailboxEmail,
    }));
  }

  async businessNames(ids: readonly string[]) {
    if (ids.length === 0) return new Map<string, string>();
    const rows = await this.x
      .select({ id: businesses.id, name: businesses.displayName })
      .from(businesses)
      .where(inArray(businesses.id, [...ids]));
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  async countPendingApprovals() {
    const [row] = await this.x
      .select({ n: count() })
      .from(outboundMessages)
      .where(eq(outboundMessages.status, 'pending_approval'));
    return Number(row?.n ?? 0);
  }
}
