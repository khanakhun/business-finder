import type { EngineEvent, EngineId, GenerationJobStatus } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import {
  businesses,
  generationArtifacts,
  generationAttempts,
  generationBatches,
  generationEvents,
  generationJobs,
  orgBusinesses,
} from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type {
  GenerationRepository,
  JobChanges,
  StoredArtifact,
  StoredAttempt,
  StoredBatch,
  StoredJob,
} from '../application/ports.ts';
import { batchStatus, type JobCounts } from '../domain/batch.ts';

const jobColumns = {
  id: generationJobs.id,
  batchId: generationJobs.batchId,
  organizationId: generationJobs.organizationId,
  businessId: generationJobs.businessId,
  businessName: businesses.displayName,
  siteId: generationJobs.siteId,
  briefOverrides: generationJobs.briefOverrides,
  position: generationJobs.position,
  priority: generationJobs.priority,
  engineRequested: generationJobs.engineRequested,
  engineCurrent: generationJobs.engineCurrent,
  engineSelectionReason: generationJobs.engineSelectionReason,
  status: generationJobs.status,
  attemptCount: generationJobs.attemptCount,
  engineAttempts: generationJobs.engineAttempts,
  maxAttemptsPerEngine: generationJobs.maxAttemptsPerEngine,
  failoverChain: generationJobs.failoverChain,
  budgetUsd: generationJobs.budgetUsd,
  costUsd: generationJobs.costUsd,
  resultVersionId: generationJobs.resultVersionId,
  publishedUrl: generationJobs.publishedUrl,
  qualityScore: generationJobs.qualityScore,
  errorCode: generationJobs.errorCode,
  errorMessage: generationJobs.errorMessage,
  cancelRequestedAt: generationJobs.cancelRequestedAt,
  dispatchedAt: generationJobs.dispatchedAt,
  createdAt: generationJobs.createdAt,
  startedAt: generationJobs.startedAt,
  finishedAt: generationJobs.finishedAt,
};

const attemptColumns = {
  id: generationAttempts.id,
  jobId: generationAttempts.jobId,
  attemptNo: generationAttempts.attemptNo,
  engine: generationAttempts.engine,
  mode: generationAttempts.mode,
  status: generationAttempts.status,
  heartbeatAt: generationAttempts.heartbeatAt,
  startedAt: generationAttempts.startedAt,
  finishedAt: generationAttempts.finishedAt,
  costUsd: generationAttempts.costUsd,
  specRef: generationAttempts.specRef,
  exitReason: generationAttempts.exitReason,
  error: generationAttempts.error,
};

@Injectable()
export class DrizzleGenerationRepository implements GenerationRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private get x() {
    return getExecutor(this.db);
  }

  private jobQuery() {
    return this.x
      .select(jobColumns)
      .from(generationJobs)
      .innerJoin(businesses, eq(businesses.id, generationJobs.businessId));
  }

  async insertBatch(batch: Parameters<GenerationRepository['insertBatch']>[0]) {
    await this.x.insert(generationBatches).values(batch);
  }

  async insertJobs(jobs: Parameters<GenerationRepository['insertJobs']>[0]) {
    if (jobs.length > 0) await this.x.insert(generationJobs).values([...jobs]);
  }

  async batchByIdempotencyKey(organizationId: string, key: string) {
    const [row] = await this.x
      .select()
      .from(generationBatches)
      .where(
        and(eq(generationBatches.organizationId, organizationId), eq(generationBatches.idempotencyKey, key)),
      )
      .limit(1);
    return row as StoredBatch | undefined;
  }

  async batch(organizationId: string, batchId: string) {
    const [row] = await this.x
      .select()
      .from(generationBatches)
      .where(and(eq(generationBatches.organizationId, organizationId), eq(generationBatches.id, batchId)))
      .limit(1);
    return row as StoredBatch | undefined;
  }

  async batchById(batchId: string) {
    const [row] = await this.x
      .select()
      .from(generationBatches)
      .where(eq(generationBatches.id, batchId))
      .limit(1);
    return row as StoredBatch | undefined;
  }

  async batches(organizationId: string, filter: Parameters<GenerationRepository['batches']>[1]) {
    const rows = await this.x
      .select()
      .from(generationBatches)
      .where(
        and(
          eq(generationBatches.organizationId, organizationId),
          filter.status ? eq(generationBatches.status, filter.status) : undefined,
          filter.before ? lt(generationBatches.createdAt, filter.before) : undefined,
        ),
      )
      .orderBy(desc(generationBatches.createdAt))
      .limit(filter.limit);
    return rows as StoredBatch[];
  }

  async jobs(batchId: string) {
    return (await this.jobQuery()
      .where(eq(generationJobs.batchId, batchId))
      .orderBy(asc(generationJobs.priority), asc(generationJobs.position))) as StoredJob[];
  }

  async listJobs(organizationId: string, filter: Parameters<GenerationRepository['listJobs']>[1]) {
    const { after } = filter;
    return (await this.jobQuery()
      .where(
        and(
          eq(generationJobs.organizationId, organizationId),
          filter.status ? eq(generationJobs.status, filter.status) : undefined,
          filter.businessId ? eq(generationJobs.businessId, filter.businessId) : undefined,
          after
            ? or(
                lt(generationJobs.createdAt, after.createdAt),
                and(eq(generationJobs.createdAt, after.createdAt), lt(generationJobs.id, after.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(generationJobs.createdAt), desc(generationJobs.id))
      .limit(filter.limit)) as StoredJob[];
  }

  async jobArtifacts(jobId: string): Promise<StoredArtifact[]> {
    return this.x
      .select({
        id: generationArtifacts.id,
        kind: generationArtifacts.kind,
        attemptNo: generationAttempts.attemptNo,
        storageKey: generationArtifacts.storageKey,
        sha256: generationArtifacts.sha256,
        bytes: generationArtifacts.bytes,
        createdAt: generationArtifacts.createdAt,
      })
      .from(generationArtifacts)
      .leftJoin(generationAttempts, eq(generationAttempts.id, generationArtifacts.attemptId))
      .where(eq(generationArtifacts.jobId, jobId))
      .orderBy(desc(generationArtifacts.createdAt));
  }

  async job(organizationId: string, jobId: string) {
    const [row] = await this.jobQuery()
      .where(and(eq(generationJobs.organizationId, organizationId), eq(generationJobs.id, jobId)))
      .limit(1);
    return row as StoredJob | undefined;
  }

  async jobById(jobId: string) {
    const [row] = await this.jobQuery().where(eq(generationJobs.id, jobId)).limit(1);
    return row as StoredJob | undefined;
  }

  async lockJob(jobId: string) {
    const [row] = await this.jobQuery()
      .where(eq(generationJobs.id, jobId))
      .limit(1)
      .for('update', { of: generationJobs });
    return row as StoredJob | undefined;
  }

  async updateJob(jobId: string, changes: JobChanges) {
    if (Object.keys(changes).length === 0) return;
    await this.x.update(generationJobs).set(changes).where(eq(generationJobs.id, jobId));
  }

  async addCost(
    jobId: string,
    batchId: string,
    attemptId: string,
    costUsd: number,
    usage: { inputTokens: number; outputTokens: number },
  ) {
    if (costUsd === 0 && usage.inputTokens === 0 && usage.outputTokens === 0) return;
    const merge = (column: typeof generationJobs.usage | typeof generationAttempts.usage) =>
      sql`jsonb_build_object('inputTokens', coalesce((${column}->>'inputTokens')::int, 0) + ${usage.inputTokens}, 'outputTokens', coalesce((${column}->>'outputTokens')::int, 0) + ${usage.outputTokens})`;
    await this.x
      .update(generationJobs)
      .set({ costUsd: sql`${generationJobs.costUsd} + ${costUsd}`, usage: merge(generationJobs.usage) })
      .where(eq(generationJobs.id, jobId));
    await this.x
      .update(generationAttempts)
      .set({
        costUsd: sql`${generationAttempts.costUsd} + ${costUsd}`,
        usage: merge(generationAttempts.usage),
      })
      .where(eq(generationAttempts.id, attemptId));
    await this.x
      .update(generationBatches)
      .set({ costUsd: sql`${generationBatches.costUsd} + ${costUsd}` })
      .where(eq(generationBatches.id, batchId));
  }

  async refreshBatch(batchId: string, now: Date) {
    // Serialized per batch: a job settling at the same moment has committed before this counts (READ COMMITTED).
    await this.lockBatch(batchId);
    const rows = await this.x
      .select({ status: generationJobs.status, n: sql<number>`count(*)::int` })
      .from(generationJobs)
      .where(eq(generationJobs.batchId, batchId))
      .groupBy(generationJobs.status);
    const counts: JobCounts = Object.fromEntries(rows.map((row) => [row.status, row.n]));
    const status = batchStatus(counts);
    const settled = status === 'completed' || status === 'completed_with_issues' || status === 'cancelled';
    await this.x
      .update(generationBatches)
      .set({
        counts,
        status,
        startedAt:
          status === 'queued'
            ? undefined
            : sql`coalesce(${generationBatches.startedAt}, ${now.toISOString()}::timestamptz)`,
        finishedAt: settled
          ? sql`coalesce(${generationBatches.finishedAt}, ${now.toISOString()}::timestamptz)`
          : null,
      })
      .where(eq(generationBatches.id, batchId));
    return this.batchById(batchId);
  }

  async insertAttempt(attempt: Parameters<GenerationRepository['insertAttempt']>[0]) {
    const rows = await this.x
      .insert(generationAttempts)
      .values(attempt)
      .onConflictDoNothing({ target: [generationAttempts.jobId, generationAttempts.attemptNo] })
      .returning({ id: generationAttempts.id });
    return rows.length > 0;
  }

  async attempt(jobId: string, attemptNo: number) {
    const [row] = await this.x
      .select(attemptColumns)
      .from(generationAttempts)
      .where(and(eq(generationAttempts.jobId, jobId), eq(generationAttempts.attemptNo, attemptNo)))
      .limit(1);
    return row as StoredAttempt | undefined;
  }

  async attemptById(attemptId: string) {
    const [row] = await this.x
      .select(attemptColumns)
      .from(generationAttempts)
      .where(eq(generationAttempts.id, attemptId))
      .limit(1);
    return row as StoredAttempt | undefined;
  }

  async attempts(jobId: string) {
    return (await this.x
      .select(attemptColumns)
      .from(generationAttempts)
      .where(eq(generationAttempts.jobId, jobId))
      .orderBy(asc(generationAttempts.attemptNo))) as StoredAttempt[];
  }

  async setAttemptWorkspace(
    attemptId: string,
    workspace: { factSnapshotId: string | null; bundleHash: string | null },
  ) {
    await this.x
      .update(generationAttempts)
      .set({ factSnapshotId: workspace.factSnapshotId, bundleHash: workspace.bundleHash })
      .where(eq(generationAttempts.id, attemptId));
  }

  async finishAttempt(attemptId: string, changes: Parameters<GenerationRepository['finishAttempt']>[1]) {
    // Only a running attempt finishes (the runner and the reaper never both settle it).
    const rows = await this.x
      .update(generationAttempts)
      .set(changes)
      .where(and(eq(generationAttempts.id, attemptId), eq(generationAttempts.status, 'running')))
      .returning({ id: generationAttempts.id });
    return rows.length > 0;
  }

  async heartbeat(attemptId: string, at: Date) {
    await this.x
      .update(generationAttempts)
      .set({ heartbeatAt: at })
      .where(and(eq(generationAttempts.id, attemptId), eq(generationAttempts.status, 'running')));
  }

  async staleAttempts(before: Date, limit: number) {
    return (await this.x
      .select(attemptColumns)
      .from(generationAttempts)
      .where(and(eq(generationAttempts.status, 'running'), lt(generationAttempts.heartbeatAt, before)))
      .orderBy(asc(generationAttempts.heartbeatAt))
      .limit(limit)) as StoredAttempt[];
  }

  async appendEvents(jobId: string, attemptId: string | null, events: readonly EngineEvent[]) {
    if (events.length === 0) return [];
    // One writer per job at a time: the sequence stays gapless and unique.
    await this.x.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`gen-events:${jobId}`}, 0))`);
    const [last] = await this.x
      .select({ seq: sql<number>`coalesce(max(${generationEvents.seq}), 0)::int` })
      .from(generationEvents)
      .where(eq(generationEvents.jobId, jobId));
    const start = (last?.seq ?? 0) + 1;
    await this.x.insert(generationEvents).values(
      events.map((event, index) => ({
        jobId,
        attemptId,
        seq: start + index,
        type: event.type,
        payload: event as Record<string, unknown>,
      })),
    );
    return events.map((_, index) => start + index);
  }

  async events(jobId: string, afterSeq: number, limit: number) {
    return this.x
      .select({
        seq: generationEvents.seq,
        type: generationEvents.type,
        payload: generationEvents.payload,
        attemptNo: generationAttempts.attemptNo,
        createdAt: generationEvents.createdAt,
      })
      .from(generationEvents)
      .leftJoin(generationAttempts, eq(generationAttempts.id, generationEvents.attemptId))
      .where(and(eq(generationEvents.jobId, jobId), gt(generationEvents.seq, afterSeq)))
      .orderBy(asc(generationEvents.seq))
      .limit(limit);
  }

  async insertArtifact(artifact: Parameters<GenerationRepository['insertArtifact']>[0]) {
    await this.x
      .insert(generationArtifacts)
      .values({ ...artifact, kind: artifact.kind as 'site_spec' })
      .onConflictDoNothing({ target: generationArtifacts.storageKey });
  }

  async artifactKey(jobId: string, attemptId: string, kind: string) {
    const rows = await this.x
      .select({ key: generationArtifacts.storageKey, attemptId: generationArtifacts.attemptId })
      .from(generationArtifacts)
      .where(and(eq(generationArtifacts.jobId, jobId), eq(generationArtifacts.kind, kind as 'site_spec')))
      .orderBy(desc(generationArtifacts.createdAt))
      .limit(20);
    return (rows.find((row) => row.attemptId === attemptId) ?? rows[0])?.key;
  }

  async deleteEventsBefore(before: Date, limit: number) {
    const rows = await this.x.execute<{ id: number }>(sql`
      DELETE FROM ${generationEvents} WHERE ${generationEvents.id} IN (
        SELECT ${generationEvents.id} FROM ${generationEvents} WHERE ${generationEvents.createdAt} < ${before} LIMIT ${limit}
      ) RETURNING ${generationEvents.id}`);
    return rows.length;
  }

  async trackedBusinesses(organizationId: string, ids: readonly string[]) {
    if (ids.length === 0) return new Map<string, string>();
    const rows = await this.x
      .select({ id: businesses.id, name: businesses.displayName })
      .from(orgBusinesses)
      .innerJoin(businesses, eq(businesses.id, orgBusinesses.businessId))
      .where(
        and(eq(orgBusinesses.organizationId, organizationId), inArray(orgBusinesses.businessId, [...ids])),
      );
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  async engineLoad(_organizationId: string) {
    const rows = await this.x
      .select({
        engine: generationJobs.engineCurrent,
        status: generationJobs.status,
        n: sql<number>`count(*)::int`,
      })
      .from(generationJobs)
      .where(
        inArray(generationJobs.status, [
          'queued',
          'preparing',
          'running',
          'validating',
          'repairing',
        ] as GenerationJobStatus[]),
      )
      .groupBy(generationJobs.engineCurrent, generationJobs.status);
    const load = new Map<EngineId, { queued: number; running: number }>();
    for (const row of rows) {
      const entry = load.get(row.engine) ?? { queued: 0, running: 0 };
      if (row.status === 'queued') entry.queued += row.n;
      else entry.running += row.n;
      load.set(row.engine, entry);
    }
    return load;
  }

  async lockBatch(batchId: string) {
    await this.x.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`gen-batch:${batchId}`}, 0))`);
  }

  /** Jobs of a batch waiting to be handed to their queues, in priority order. */
  async undispatched(batchId: string, limit: number) {
    return (await this.jobQuery()
      .where(
        and(
          eq(generationJobs.batchId, batchId),
          eq(generationJobs.status, 'queued'),
          isNull(generationJobs.dispatchedAt),
        ),
      )
      .orderBy(asc(generationJobs.priority), asc(generationJobs.position))
      .limit(limit)) as StoredJob[];
  }

  /** Jobs of a batch handed to their queues and not settled yet. */
  async inFlight(batchId: string) {
    const [row] = await this.x
      .select({ n: sql<number>`count(*)::int` })
      .from(generationJobs)
      .where(
        and(
          eq(generationJobs.batchId, batchId),
          inArray(generationJobs.status, [
            'queued',
            'preparing',
            'running',
            'validating',
            'repairing',
          ] as GenerationJobStatus[]),
          sql`${generationJobs.dispatchedAt} IS NOT NULL`,
        ),
      );
    return row?.n ?? 0;
  }
}
