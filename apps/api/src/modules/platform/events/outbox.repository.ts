import { type DbClient, getExecutor } from '@bf/db';
import { outboxEvents } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../db/db.module.ts';

export type OutboxRow = typeof outboxEvents.$inferSelect;
export type NewOutboxRow = typeof outboxEvents.$inferInsert;

/** `outbox_events`: inserted in the use case's transaction, claimed by relays with SKIP LOCKED. */
@Injectable()
export class OutboxRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async insert(row: NewOutboxRow): Promise<void> {
    await getExecutor(this.db).insert(outboxEvents).values(row);
  }

  /**
   * Locks up to `limit` due, undispatched events for the caller's transaction. Concurrent relays skip each other's
   * rows (`FOR UPDATE SKIP LOCKED`), so an event is dispatched by one relay at a time.
   */
  async claimPending(limit: number, now: Date): Promise<OutboxRow[]> {
    return getExecutor(this.db)
      .select()
      .from(outboxEvents)
      .where(and(isNull(outboxEvents.dispatchedAt), lte(outboxEvents.availableAt, now)))
      .orderBy(asc(outboxEvents.availableAt), asc(outboxEvents.id))
      .limit(limit)
      .for('update', { skipLocked: true });
  }

  async markDispatched(ids: readonly string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await getExecutor(this.db)
      .update(outboxEvents)
      .set({ dispatchedAt: at, lastError: null })
      .where(inArray(outboxEvents.id, [...ids]));
  }

  async markFailed(id: string, error: string, retryAt: Date): Promise<void> {
    await getExecutor(this.db)
      .update(outboxEvents)
      .set({
        attempts: sql`${outboxEvents.attempts} + 1`,
        lastError: error.slice(0, 1000),
        availableAt: retryAt,
      })
      .where(eq(outboxEvents.id, id));
  }

  async find(id: string): Promise<OutboxRow | undefined> {
    const [row] = await getExecutor(this.db).select().from(outboxEvents).where(eq(outboxEvents.id, id));
    return row;
  }

  async pendingCount(): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(outboxEvents)
      .where(isNull(outboxEvents.dispatchedAt));
    return row?.n ?? 0;
  }

  /** Events still undispatched after `olderThan` become due now (overriding backoff); returns how many. */
  async releaseStuck(olderThan: Date, now: Date): Promise<number> {
    const rows = await this.db
      .update(outboxEvents)
      .set({ availableAt: now })
      .where(and(isNull(outboxEvents.dispatchedAt), lte(outboxEvents.occurredAt, olderThan)))
      .returning({ id: outboxEvents.id });
    return rows.length;
  }
}
