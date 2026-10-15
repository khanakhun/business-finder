import type { RunEndReason, RunStatus, SourceRecordInput } from '@bf/contracts';
import { type DbClient, getExecutor, runInTransaction } from '@bf/db';
import { discoveryRuns, discoveryTasks } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type {
  After,
  DiscoveryRunRepository,
  FetchOutcome,
  IngestCounts,
  NewRun,
  NewTask,
  Page,
  RunBusinessRow,
  RunRecord,
  TaskRecord,
} from '../application/run-ports.ts';
import { finalOutcome } from '../domain/run-state-machine.ts';

type RunRow = typeof discoveryRuns.$inferSelect;
type TaskRow = typeof discoveryTasks.$inferSelect;
type Tx = Parameters<Parameters<typeof runInTransaction>[1]>[0];

const toRun = (r: RunRow): RunRecord => ({
  id: r.id,
  organizationId: r.organizationId,
  createdBy: r.createdBy,
  intent: r.intent,
  areaId: r.areaId,
  areaGeometry: r.areaGeometry as RunRecord['areaGeometry'],
  providers: r.providers,
  options: r.options,
  status: r.status,
  reason: r.reason,
  budgetUsd: Number(r.budgetUsd),
  costUsd: Number(r.costUsd),
  reservedUsd: Number(r.reservedUsd),
  budgetExhausted: r.budgetExhausted,
  counts: {
    tasksTotal: r.tasksTotal,
    tasksDone: r.tasksDone,
    tasksFailed: r.tasksFailed,
    tasksSkipped: r.tasksSkipped,
    recordsFetched: r.recordsFetched,
    created: r.createdCount,
    merged: r.mergedCount,
    unchanged: r.unchangedCount,
    possibleDuplicates: r.possibleDuplicates,
    failedRecords: r.failedRecords,
  },
  ingestsPending: r.ingestsPending,
  requestHash: r.requestHash,
  plannedAt: r.plannedAt,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
  createdAt: r.createdAt,
});

const toTask = (t: TaskRow): TaskRecord => ({
  id: t.id,
  runId: t.runId,
  parentTaskId: t.parentTaskId,
  provider: t.provider,
  categoryId: t.categoryId,
  query: t.query,
  depth: t.depth,
  status: t.status,
  attempt: t.attempt,
  records: t.records,
  saturated: t.saturated,
  costUsd: Number(t.costUsd),
  notBefore: t.notBefore,
  error: t.error,
  createdAt: t.createdAt,
});

const OPEN_TASK = inArray(discoveryTasks.status, ['queued', 'running']);
const ACTIVE_RUN = inArray(discoveryRuns.status, ['queued', 'running']);

function page<T extends { id: string }, R>(rows: T[], limit: number, map: (row: T) => R): Page<R> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items: items.map(map), next: rows.length > limit && last ? { id: last.id } : null };
}

@Injectable()
export class DrizzleDiscoveryRunRepository implements DiscoveryRunRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private get x() {
    return getExecutor(this.db);
  }

  async createRun(run: NewRun) {
    const [inserted] = await this.x
      .insert(discoveryRuns)
      .values({
        organizationId: run.organizationId,
        createdBy: run.createdBy,
        intent: run.intent,
        areaId: run.areaId,
        areaGeometry: run.areaGeometry,
        providers: [...run.providers],
        options: run.options,
        budgetUsd: run.budgetUsd,
        idempotencyKey: run.idempotencyKey,
        requestHash: run.requestHash,
      })
      .onConflictDoNothing({ target: [discoveryRuns.organizationId, discoveryRuns.idempotencyKey] })
      .returning();
    if (inserted) return { run: toRun(inserted), created: true };
    const [existing] = await this.x
      .select()
      .from(discoveryRuns)
      .where(
        and(
          eq(discoveryRuns.organizationId, run.organizationId),
          eq(discoveryRuns.idempotencyKey, run.idempotencyKey ?? ''),
        ),
      );
    if (!existing) throw new Error('Run conflict without an existing run');
    return { run: toRun(existing), created: false };
  }

  async findByIdempotencyKey(organizationId: string, key: string) {
    const [row] = await this.x
      .select()
      .from(discoveryRuns)
      .where(and(eq(discoveryRuns.organizationId, organizationId), eq(discoveryRuns.idempotencyKey, key)));
    return row ? toRun(row) : undefined;
  }

  async activeRunCount(organizationId: string) {
    // Transaction-scoped advisory lock: two concurrent starts of one workspace cannot both pass the limit.
    await this.x.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`discovery_runs:${organizationId}`}, 0))`,
    );
    const [row] = await this.x
      .select({ n: sql<number>`count(*)::int` })
      .from(discoveryRuns)
      .where(and(eq(discoveryRuns.organizationId, organizationId), ACTIVE_RUN));
    return row?.n ?? 0;
  }

  async getRun(id: string, organizationId?: string) {
    const [row] = await this.x
      .select()
      .from(discoveryRuns)
      .where(
        and(
          eq(discoveryRuns.id, id),
          organizationId ? eq(discoveryRuns.organizationId, organizationId) : undefined,
        ),
      );
    return row ? toRun(row) : undefined;
  }

  async listRuns(organizationId: string, filter: { status?: RunStatus; limit: number; after?: After }) {
    const rows = await this.x
      .select()
      .from(discoveryRuns)
      .where(
        and(
          eq(discoveryRuns.organizationId, organizationId),
          filter.status ? eq(discoveryRuns.status, filter.status) : undefined,
          filter.after ? lt(discoveryRuns.id, filter.after.id) : undefined,
        ),
      )
      .orderBy(desc(discoveryRuns.id))
      .limit(filter.limit + 1);
    return page(rows, filter.limit, toRun);
  }

  async startRun(runId: string, now: Date) {
    const rows = await this.x
      .update(discoveryRuns)
      .set({ status: 'running', startedAt: now })
      .where(and(eq(discoveryRuns.id, runId), eq(discoveryRuns.status, 'queued')))
      .returning({ id: discoveryRuns.id });
    return rows.length > 0;
  }

  async addTasks(runId: string, tasks: readonly NewTask[], options: { planned?: boolean } = {}) {
    if (tasks.length === 0 && !options.planned) return [];
    return runInTransaction(this.db, async (tx) => {
      // Locks the run so a concurrent cancel or finalize cannot interleave: an ended run gets no new tasks.
      const run = await this.lockRun(tx, runId);
      if (run?.status !== 'running') return [];
      const inserted = await this.insertTasks(tx, runId, tasks);
      if (options.planned) {
        await tx
          .update(discoveryRuns)
          .set({ plannedAt: sql`coalesce(${discoveryRuns.plannedAt}, now())` })
          .where(eq(discoveryRuns.id, runId));
      }
      return inserted;
    });
  }

  /** Lock order everywhere: the run row, then task rows (no deadlocks between steps). */
  private async lockRun(tx: Tx, runId: string) {
    const [run] = await tx
      .select({ status: discoveryRuns.status })
      .from(discoveryRuns)
      .where(eq(discoveryRuns.id, runId))
      .for('update');
    return run;
  }

  private async insertTasks(tx: Tx, runId: string, tasks: readonly NewTask[]) {
    const inserted: TaskRecord[] = [];
    // Chunks keep statements within parameter limits for large plans.
    for (let i = 0; i < tasks.length; i += 500) {
      const rows = await tx
        .insert(discoveryTasks)
        .values(
          tasks.slice(i, i + 500).map((t) => ({
            runId,
            provider: t.provider,
            categoryId: t.categoryId,
            query: t.query,
            depth: t.depth,
            parentTaskId: t.parentTaskId,
            dedupeKey: t.dedupeKey,
            notBefore: t.notBefore ?? null,
          })),
        )
        .onConflictDoNothing({ target: [discoveryTasks.runId, discoveryTasks.dedupeKey] })
        .returning();
      inserted.push(...rows.map(toTask));
    }
    if (inserted.length > 0) {
      await tx
        .update(discoveryRuns)
        .set({ tasksTotal: sql`${discoveryRuns.tasksTotal} + ${inserted.length}` })
        .where(eq(discoveryRuns.id, runId));
    }
    return inserted;
  }

  async getTask(taskId: string) {
    const [row] = await this.x.select().from(discoveryTasks).where(eq(discoveryTasks.id, taskId));
    return row ? toTask(row) : undefined;
  }

  async claimTask(taskId: string, now: Date) {
    const [row] = await this.x
      .update(discoveryTasks)
      .set({ status: 'running', heartbeatAt: now, attempt: sql`${discoveryTasks.attempt} + 1` })
      .where(and(eq(discoveryTasks.id, taskId), eq(discoveryTasks.status, 'queued')))
      .returning();
    return row ? toTask(row) : undefined;
  }

  async reserve(task: TaskRecord, amount: number) {
    return runInTransaction(this.db, async (tx) => {
      const rows = await tx
        .update(discoveryRuns)
        .set({ reservedUsd: sql`${discoveryRuns.reservedUsd} + ${amount}` })
        .where(
          and(
            eq(discoveryRuns.id, task.runId),
            eq(discoveryRuns.status, 'running'),
            sql`${discoveryRuns.costUsd} + ${discoveryRuns.reservedUsd} + ${amount} <= ${discoveryRuns.budgetUsd} + 0.000000001`,
          ),
        )
        .returning({ id: discoveryRuns.id });
      if (rows.length === 0) return false;
      // Held on the task, so whoever ends the task (or the reconciler) gives back exactly this amount.
      await tx
        .update(discoveryTasks)
        .set({ reservedUsd: sql`${discoveryTasks.reservedUsd} + ${amount}` })
        .where(eq(discoveryTasks.id, task.id));
      return true;
    });
  }

  async releaseReservation(task: TaskRecord) {
    await runInTransaction(this.db, async (tx) => {
      await this.lockRun(tx, task.runId);
      await this.releaseIn(tx, task.id, task.runId);
    });
  }

  /** Moves the task's reservation back to the run (the run row must already be locked). */
  private async releaseIn(tx: Tx, taskId: string, runId: string) {
    const [row] = await tx
      .select({ reserved: discoveryTasks.reservedUsd })
      .from(discoveryTasks)
      .where(eq(discoveryTasks.id, taskId))
      .for('update');
    const amount = Number(row?.reserved ?? 0);
    if (amount === 0) return;
    await tx.update(discoveryTasks).set({ reservedUsd: 0 }).where(eq(discoveryTasks.id, taskId));
    await tx
      .update(discoveryRuns)
      .set({ reservedUsd: sql`greatest(0, ${discoveryRuns.reservedUsd} - ${amount})` })
      .where(eq(discoveryRuns.id, runId));
  }

  async heartbeat(taskId: string, now: Date) {
    await this.x
      .update(discoveryTasks)
      .set({ heartbeatAt: now })
      .where(and(eq(discoveryTasks.id, taskId), eq(discoveryTasks.status, 'running')));
  }

  async completeTask(task: TaskRecord, outcome: FetchOutcome, followUps: readonly NewTask[]) {
    return runInTransaction(this.db, async (tx) => {
      const run = await this.lockRun(tx, task.runId);
      await this.releaseIn(tx, task.id, task.runId);
      if (run?.status !== 'running') {
        // Ended meanwhile (cancelled): the call happened, so its cost counts, but its records are dropped.
        const [skipped] = await tx
          .update(discoveryTasks)
          .set({ status: 'skipped', error: 'cancelled', costUsd: outcome.costUsd })
          .where(and(eq(discoveryTasks.id, task.id), eq(discoveryTasks.status, 'running')))
          .returning({ id: discoveryTasks.id });
        if (skipped) {
          await tx
            .update(discoveryRuns)
            .set({
              costUsd: sql`${discoveryRuns.costUsd} + ${outcome.costUsd}`,
              tasksSkipped: sql`${discoveryRuns.tasksSkipped} + 1`,
            })
            .where(eq(discoveryRuns.id, task.runId));
        }
        return { accepted: false, created: [] };
      }
      const hasRecords = outcome.records.length > 0;
      const [updated] = await tx
        .update(discoveryTasks)
        .set({
          status: 'done',
          records: outcome.records.length,
          saturated: outcome.saturated,
          costUsd: outcome.costUsd,
          pendingRecords: hasRecords ? [...outcome.records] : null,
          ingestedAt: hasRecords ? null : sql`now()`,
          error: null,
        })
        .where(and(eq(discoveryTasks.id, task.id), eq(discoveryTasks.status, 'running')))
        .returning({ id: discoveryTasks.id });
      // A duplicate delivery of a task someone else finished: nothing to count (provider_usage has the call).
      if (!updated) return { accepted: false, created: [] };
      await tx
        .update(discoveryRuns)
        .set({
          costUsd: sql`${discoveryRuns.costUsd} + ${outcome.costUsd}`,
          tasksDone: sql`${discoveryRuns.tasksDone} + 1`,
          recordsFetched: sql`${discoveryRuns.recordsFetched} + ${outcome.records.length}`,
          ingestsPending: sql`${discoveryRuns.ingestsPending} + ${hasRecords ? 1 : 0}`,
        })
        .where(eq(discoveryRuns.id, task.runId));
      return { accepted: true, created: await this.insertTasks(tx, task.runId, followUps) };
    });
  }

  async failTask(task: TaskRecord, error: string) {
    await runInTransaction(this.db, async (tx) => {
      await this.lockRun(tx, task.runId);
      await this.releaseIn(tx, task.id, task.runId);
      const [updated] = await tx
        .update(discoveryTasks)
        .set({ status: 'failed', error: error.slice(0, 200) })
        .where(and(eq(discoveryTasks.id, task.id), OPEN_TASK))
        .returning({ id: discoveryTasks.id });
      if (updated) {
        await tx
          .update(discoveryRuns)
          .set({ tasksFailed: sql`${discoveryRuns.tasksFailed} + 1` })
          .where(eq(discoveryRuns.id, task.runId));
      }
    });
  }

  async requeueTask(taskId: string) {
    const task = await this.getTask(taskId);
    if (!task) return;
    await runInTransaction(this.db, async (tx) => {
      await this.lockRun(tx, task.runId);
      await this.releaseIn(tx, task.id, task.runId);
      await tx
        .update(discoveryTasks)
        .set({ status: 'queued', heartbeatAt: null })
        .where(and(eq(discoveryTasks.id, taskId), eq(discoveryTasks.status, 'running')));
    });
  }

  async skipTask(task: TaskRecord, error: string | null) {
    return runInTransaction(this.db, async (tx) => {
      await this.lockRun(tx, task.runId);
      await this.releaseIn(tx, task.id, task.runId);
      const [updated] = await tx
        .update(discoveryTasks)
        .set({ status: 'skipped', error })
        .where(and(eq(discoveryTasks.id, task.id), OPEN_TASK))
        .returning({ id: discoveryTasks.id });
      if (!updated) return false;
      await tx
        .update(discoveryRuns)
        .set({ tasksSkipped: sql`${discoveryRuns.tasksSkipped} + 1` })
        .where(eq(discoveryRuns.id, task.runId));
      return true;
    });
  }

  async skipQueued(runId: string, error: string) {
    return runInTransaction(this.db, async (tx) => {
      const rows = await tx
        .update(discoveryTasks)
        .set({ status: 'skipped', error })
        .where(and(eq(discoveryTasks.runId, runId), eq(discoveryTasks.status, 'queued')))
        .returning({ id: discoveryTasks.id });
      if (rows.length > 0) {
        await tx
          .update(discoveryRuns)
          .set({ tasksSkipped: sql`${discoveryRuns.tasksSkipped} + ${rows.length}` })
          .where(eq(discoveryRuns.id, runId));
      }
      return rows.length;
    });
  }

  async markStop(runId: string, reason: RunEndReason) {
    // The first stop reason wins (a budget stop is not overwritten by a later one).
    await this.x
      .update(discoveryRuns)
      .set({ budgetExhausted: true, reason: sql`coalesce(${discoveryRuns.reason}, ${reason})` })
      .where(eq(discoveryRuns.id, runId));
  }

  async pendingRecords(taskId: string) {
    const [row] = await this.x
      .select({ records: discoveryTasks.pendingRecords })
      .from(discoveryTasks)
      .where(and(eq(discoveryTasks.id, taskId), isNull(discoveryTasks.ingestedAt)));
    return row?.records ? (row.records as SourceRecordInput[]) : undefined;
  }

  async applyIngest(task: TaskRecord, counts: IngestCounts) {
    return runInTransaction(this.db, async (tx) => {
      const [updated] = await tx
        .update(discoveryTasks)
        .set({ ingestedAt: sql`now()`, pendingRecords: null })
        .where(and(eq(discoveryTasks.id, task.id), isNull(discoveryTasks.ingestedAt)))
        .returning({ id: discoveryTasks.id });
      if (!updated) return false;
      await tx
        .update(discoveryRuns)
        .set({
          createdCount: sql`${discoveryRuns.createdCount} + ${counts.created}`,
          mergedCount: sql`${discoveryRuns.mergedCount} + ${counts.merged}`,
          unchangedCount: sql`${discoveryRuns.unchangedCount} + ${counts.unchanged}`,
          possibleDuplicates: sql`${discoveryRuns.possibleDuplicates} + ${counts.possibleDuplicates}`,
          failedRecords: sql`${discoveryRuns.failedRecords} + ${counts.failedRecords}`,
          ingestsPending: sql`greatest(0, ${discoveryRuns.ingestsPending} - 1)`,
        })
        .where(eq(discoveryRuns.id, task.runId));
      return true;
    });
  }

  async finalize(runId: string, now: Date) {
    return runInTransaction(this.db, async (tx) => {
      const [run] = await tx.select().from(discoveryRuns).where(eq(discoveryRuns.id, runId)).for('update');
      if (run?.status !== 'running' || !run.plannedAt || run.ingestsPending > 0) return undefined;
      const [open] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(discoveryTasks)
        .where(and(eq(discoveryTasks.runId, runId), OPEN_TASK));
      if ((open?.n ?? 0) > 0) return undefined;
      const record = toRun(run);
      const stop = run.budgetExhausted ? (run.reason ?? 'budget') : null;
      const { status, reason } = finalOutcome(record.counts, stop);
      const [ended] = await tx
        .update(discoveryRuns)
        .set({ status, reason, finishedAt: now, reservedUsd: 0 })
        .where(eq(discoveryRuns.id, runId))
        .returning();
      return ended ? toRun(ended) : undefined;
    });
  }

  async cancel(runId: string, organizationId: string, now: Date) {
    return runInTransaction(this.db, async (tx) => {
      const [run] = await tx
        .update(discoveryRuns)
        .set({ status: 'cancelled', reason: 'cancelled', finishedAt: now })
        .where(and(eq(discoveryRuns.id, runId), eq(discoveryRuns.organizationId, organizationId), ACTIVE_RUN))
        .returning();
      if (!run) return undefined;
      const skipped = await tx
        .update(discoveryTasks)
        .set({ status: 'skipped', error: 'cancelled' })
        .where(and(eq(discoveryTasks.runId, runId), eq(discoveryTasks.status, 'queued')))
        .returning({ id: discoveryTasks.id });
      const running = await tx
        .select()
        .from(discoveryTasks)
        .where(and(eq(discoveryTasks.runId, runId), eq(discoveryTasks.status, 'running')));
      const [updated] = await tx
        .update(discoveryRuns)
        .set({ tasksSkipped: sql`${discoveryRuns.tasksSkipped} + ${skipped.length}` })
        .where(eq(discoveryRuns.id, runId))
        .returning();
      return { run: toRun(updated ?? run), running: running.map(toTask) };
    });
  }

  async staleRunningTasks(before: Date, limit: number) {
    const rows = await this.x
      .select()
      .from(discoveryTasks)
      .where(and(eq(discoveryTasks.status, 'running'), lt(discoveryTasks.heartbeatAt, before)))
      .limit(limit);
    return rows.map(toTask);
  }

  async queuedTasksOlderThan(before: Date, limit: number) {
    const rows = await this.x
      .select()
      .from(discoveryTasks)
      .innerJoin(discoveryRuns, eq(discoveryRuns.id, discoveryTasks.runId))
      .where(
        and(
          eq(discoveryTasks.status, 'queued'),
          eq(discoveryRuns.status, 'running'),
          lt(discoveryTasks.updatedAt, before),
          or(isNull(discoveryTasks.notBefore), lt(discoveryTasks.notBefore, before)),
        ),
      )
      .limit(limit);
    return rows.map((r) => toTask(r.discovery_tasks));
  }

  async tasksAwaitingIngest(before: Date, limit: number) {
    const rows = await this.x
      .select()
      .from(discoveryTasks)
      .where(
        and(
          eq(discoveryTasks.status, 'done'),
          isNull(discoveryTasks.ingestedAt),
          isNotNull(discoveryTasks.pendingRecords),
          lt(discoveryTasks.updatedAt, before),
        ),
      )
      .limit(limit);
    return rows.map(toTask);
  }

  async runningRunsWithoutOpenWork(limit: number) {
    const rows = await this.x
      .select({ id: discoveryRuns.id })
      .from(discoveryRuns)
      .where(
        and(
          eq(discoveryRuns.status, 'running'),
          isNotNull(discoveryRuns.plannedAt),
          eq(discoveryRuns.ingestsPending, 0),
          sql`NOT EXISTS (SELECT 1 FROM discovery_tasks t WHERE t.run_id = ${discoveryRuns.id} AND t.status IN ('queued', 'running'))`,
        ),
      )
      .limit(limit);
    return rows.map((r) => r.id);
  }

  async unplannedRunsOlderThan(before: Date, limit: number) {
    const rows = await this.x
      .select({ id: discoveryRuns.id })
      .from(discoveryRuns)
      .where(
        or(
          and(eq(discoveryRuns.status, 'queued'), lt(discoveryRuns.createdAt, before)),
          and(
            eq(discoveryRuns.status, 'running'),
            isNull(discoveryRuns.plannedAt),
            lt(discoveryRuns.startedAt, before),
          ),
        ),
      )
      .limit(limit);
    return rows.map((r) => r.id);
  }

  async listTasks(runId: string, filter: { limit: number; after?: After }) {
    const rows = await this.x
      .select()
      .from(discoveryTasks)
      .where(
        and(
          eq(discoveryTasks.runId, runId),
          filter.after ? lt(discoveryTasks.id, filter.after.id) : undefined,
        ),
      )
      .orderBy(desc(discoveryTasks.id))
      .limit(filter.limit + 1);
    return page(rows, filter.limit, toTask);
  }

  /** Businesses this run added to the workspace (read model over business-graph tables), newest first. */
  async runBusinesses(organizationId: string, runId: string, filter: { limit: number; after?: After }) {
    const rows = (await this.x.execute(sql`
      SELECT b.id, b.display_name AS name, b.primary_category_id, b.locality,
             to_char(ob.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS tracked_at
      FROM org_businesses ob
      JOIN businesses b ON b.id = ob.business_id
      WHERE ob.organization_id = ${organizationId} AND ob.added_via = 'discovery' AND ob.added_ref = ${runId}
        ${filter.after?.at ? sql`AND (ob.created_at, b.id) < (${filter.after.at}::timestamptz, ${filter.after.id}::uuid)` : sql``}
      ORDER BY ob.created_at DESC, b.id DESC
      LIMIT ${filter.limit + 1}`)) as unknown as Array<{
      id: string;
      name: string;
      primary_category_id: string | null;
      locality: string | null;
      tracked_at: string;
    }>;
    const items = rows.slice(0, filter.limit);
    const last = items.at(-1);
    return {
      items: items.map(
        (r): RunBusinessRow => ({
          businessId: r.id,
          name: r.name,
          primaryCategoryId: r.primary_category_id,
          locality: r.locality,
          trackedAt: r.tracked_at,
        }),
      ),
      next: rows.length > filter.limit && last ? { id: last.id, at: last.tracked_at } : null,
    };
  }
}
