import type { RetentionRun } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { dsrRequests, retentionRuns } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNotNull, lt, notInArray, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { DsrRepository, RetentionRunRepository, StoredDsrRequest } from '../application/ports.ts';

@Injectable()
export class DrizzleDsrRepository implements DsrRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private get x() {
    return getExecutor(this.db);
  }

  async insert(row: Parameters<DsrRepository['insert']>[0]) {
    const [stored] = await this.x.insert(dsrRequests).values(row).returning();
    if (!stored) throw new Error('dsr request not stored');
    return stored as StoredDsrRequest;
  }

  async list(organizationId: string) {
    return (await this.x
      .select()
      .from(dsrRequests)
      .where(eq(dsrRequests.organizationId, organizationId))
      .orderBy(desc(dsrRequests.receivedAt))
      .limit(500)) as StoredDsrRequest[];
  }

  async get(organizationId: string, id: string) {
    const [row] = await this.x
      .select()
      .from(dsrRequests)
      .where(and(eq(dsrRequests.organizationId, organizationId), eq(dsrRequests.id, id)));
    return row as StoredDsrRequest | undefined;
  }

  async update(organizationId: string, id: string, patch: Parameters<DsrRepository['update']>[2]) {
    const [row] = await this.x
      .update(dsrRequests)
      .set(patch)
      .where(and(eq(dsrRequests.organizationId, organizationId), eq(dsrRequests.id, id)))
      .returning();
    if (!row) throw new Error('dsr request update matched no row');
    return row as StoredDsrRequest;
  }

  async openDueBefore(before: Date) {
    return (await this.x
      .select()
      .from(dsrRequests)
      .where(and(notInArray(dsrRequests.status, ['completed', 'rejected']), lt(dsrRequests.dueAt, before)))
      .limit(500)) as StoredDsrRequest[];
  }

  async exportsBefore(before: Date, limit: number) {
    return (await this.x
      .select()
      .from(dsrRequests)
      .where(
        and(
          eq(dsrRequests.status, 'completed'),
          isNotNull(dsrRequests.exportKey),
          lt(dsrRequests.updatedAt, before),
        ),
      )
      .limit(limit)) as StoredDsrRequest[];
  }
}

const toRun = (row: typeof retentionRuns.$inferSelect): RetentionRun => ({
  id: row.id,
  dryRun: row.dryRun,
  startedAt: row.startedAt.toISOString(),
  finishedAt: row.finishedAt?.toISOString() ?? null,
  results: row.results,
  triggeredBy: row.triggeredBy,
});

@Injectable()
export class DrizzleRetentionRunRepository implements RetentionRunRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async start(dryRun: boolean, triggeredBy: string | null) {
    const [row] = await this.db
      .insert(retentionRuns)
      .values({ dryRun, triggeredBy })
      .returning({ id: retentionRuns.id });
    if (!row) throw new Error('retention run not stored');
    return row.id;
  }

  async finish(id: string, results: RetentionRun['results']) {
    const [row] = await this.db
      .update(retentionRuns)
      .set({ results, finishedAt: new Date() })
      .where(eq(retentionRuns.id, id))
      .returning();
    if (!row) throw new Error('retention run missing');
    return toRun(row);
  }

  async recent(limit: number) {
    const rows = await this.db
      .select()
      .from(retentionRuns)
      .orderBy(desc(retentionRuns.startedAt))
      .limit(limit);
    return rows.map(toRun);
  }

  /** A transaction-scoped advisory lock, then "no real run in the last 20 hours" — one daily run across workers. */
  async claimDailyRun() {
    return this.db.transaction(async (tx) => {
      const [lock] = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(hashtext('bf.retention.daily')) AS locked`,
      );
      if (!lock?.locked) return null;
      const [recent] = await tx
        .select({ id: retentionRuns.id })
        .from(retentionRuns)
        .where(
          and(eq(retentionRuns.dryRun, false), gt(retentionRuns.startedAt, sql`now() - interval '20 hours'`)),
        )
        .limit(1);
      if (recent) return null;
      const [row] = await tx
        .insert(retentionRuns)
        .values({ dryRun: false })
        .returning({ id: retentionRuns.id });
      return row?.id ?? null;
    });
  }
}
