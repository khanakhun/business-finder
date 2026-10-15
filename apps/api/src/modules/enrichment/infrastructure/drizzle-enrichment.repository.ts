import type {
  EnrichmentRunStatus,
  EnrichmentSkipReason,
  EnrichmentStepId,
  EnrichmentTrigger,
} from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { businesses, enrichmentRuns, enrichmentSteps, orgBusinesses } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type {
  EnrichmentRepository,
  NewRun,
  NewStep,
  RunRecord,
  StepCompletion,
  StepRecord,
} from '../application/ports.ts';
import type { StepOutput } from '../domain/enrichment-step.ts';

/** `ARRAY[$1, $2, …]::text[]` (Drizzle would expand a JS array into a row, not an array). */
const textArray = (values: readonly string[]) =>
  values.length === 0
    ? sql`ARRAY[]::text[]`
    : sql`ARRAY[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]`;

const timestampArray = (values: readonly Date[]) =>
  sql`ARRAY[${sql.join(
    values.map((v) => sql`${v.toISOString()}`),
    sql`, `,
  )}]::timestamptz[]`;

/** Every dependency of the step (within its run) is terminal. */
const dependenciesSettled = sql`NOT EXISTS (SELECT 1 FROM ${enrichmentSteps} d
  WHERE d.run_id = ${enrichmentSteps.runId} AND d.step = ANY(${enrichmentSteps.dependsOn})
  AND d.status IN ('queued', 'running'))`;

type RunRow = typeof enrichmentRuns.$inferSelect;
type StepRow = typeof enrichmentSteps.$inferSelect;

const OPEN: EnrichmentRunStatus[] = ['queued', 'running'];

const toRun = (r: RunRow): RunRecord => ({
  id: r.id,
  businessId: r.businessId,
  organizationId: r.triggeredByOrgId,
  requestedBy: r.requestedBy,
  trigger: r.trigger,
  requestedSteps: r.requestedSteps,
  force: r.force,
  status: r.status,
  estimatedUsd: Number(r.estimatedUsd),
  costUsd: Number(r.costUsd),
  changedFields: r.changedFields,
  error: r.error,
  createdAt: r.createdAt,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
});

const toStep = (s: StepRow): StepRecord => ({
  id: s.id,
  runId: s.runId,
  businessId: s.businessId,
  step: s.step,
  dependsOn: s.dependsOn,
  status: s.status,
  attempt: s.attempt,
  inputHash: s.inputHash,
  outputRef: s.outputRef,
  estimatedUsd: Number(s.estimatedUsd),
  costUsd: Number(s.costUsd),
  skipReason: s.skipReason,
  error: s.error,
  heartbeatAt: s.heartbeatAt,
  notBefore: s.notBefore,
  jobId: s.jobId,
  startedAt: s.startedAt,
  finishedAt: s.finishedAt,
  updatedAt: s.updatedAt,
});

/** First instant of the calendar month (UTC) of `at`, and of the next one. */
function monthRange(at: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { start, end };
}

@Injectable()
export class DrizzleEnrichmentRepository implements EnrichmentRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private get x() {
    return getExecutor(this.db);
  }

  async lockOrganization(organizationId: string): Promise<void> {
    await this.x.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`enrichment:${organizationId}`}, 0))`,
    );
  }

  async countOpenRuns(organizationId: string): Promise<number> {
    const [row] = await this.x
      .select({ n: sql<number>`count(*)::int` })
      .from(enrichmentRuns)
      .where(and(eq(enrichmentRuns.triggeredByOrgId, organizationId), inArray(enrichmentRuns.status, OPEN)));
    return row?.n ?? 0;
  }

  async createRun(run: NewRun, steps: readonly NewStep[]): Promise<RunRecord> {
    const [row] = await this.x
      .insert(enrichmentRuns)
      .values({
        businessId: run.businessId,
        triggeredByOrgId: run.organizationId,
        requestedBy: run.requestedBy,
        trigger: run.trigger,
        requestedSteps: [...run.requestedSteps],
        force: run.force,
        estimatedUsd: run.estimatedUsd,
        idempotencyKey: run.idempotencyKey,
      })
      .returning();
    if (!row) throw new Error('enrichment run not inserted');
    if (steps.length > 0) {
      await this.x.insert(enrichmentSteps).values(
        steps.map((step) => ({
          runId: row.id,
          businessId: run.businessId,
          step: step.step,
          dependsOn: [...step.dependsOn],
          status: step.status,
          skipReason: step.skipReason,
          inputHash: step.inputHash,
          estimatedUsd: step.estimatedUsd,
          ...(step.status === 'skipped' ? { finishedAt: row.createdAt } : {}),
        })),
      );
    }
    return toRun(row);
  }

  async findByIdempotencyKey(organizationId: string, key: string): Promise<RunRecord | undefined> {
    const [row] = await this.x
      .select()
      .from(enrichmentRuns)
      .where(
        and(eq(enrichmentRuns.triggeredByOrgId, organizationId), eq(enrichmentRuns.idempotencyKey, key)),
      );
    return row ? toRun(row) : undefined;
  }

  async findOpenRun(organizationId: string, businessId: string): Promise<RunRecord | undefined> {
    const [row] = await this.x
      .select()
      .from(enrichmentRuns)
      .where(
        and(
          eq(enrichmentRuns.businessId, businessId),
          eq(enrichmentRuns.triggeredByOrgId, organizationId),
          inArray(enrichmentRuns.status, OPEN),
        ),
      )
      .orderBy(desc(enrichmentRuns.createdAt))
      .limit(1);
    return row ? toRun(row) : undefined;
  }

  async findRun(runId: string): Promise<RunRecord | undefined> {
    const [row] = await this.x.select().from(enrichmentRuns).where(eq(enrichmentRuns.id, runId));
    return row ? toRun(row) : undefined;
  }

  async lockRun(runId: string): Promise<RunRecord | undefined> {
    const [row] = await this.x
      .select()
      .from(enrichmentRuns)
      .where(eq(enrichmentRuns.id, runId))
      .for('update');
    return row ? toRun(row) : undefined;
  }

  async latestRun(organizationId: string, businessId: string): Promise<RunRecord | undefined> {
    const [row] = await this.x
      .select()
      .from(enrichmentRuns)
      .where(
        and(eq(enrichmentRuns.businessId, businessId), eq(enrichmentRuns.triggeredByOrgId, organizationId)),
      )
      .orderBy(desc(enrichmentRuns.createdAt))
      .limit(1);
    return row ? toRun(row) : undefined;
  }

  async steps(runId: string): Promise<StepRecord[]> {
    const rows = await this.x
      .select()
      .from(enrichmentSteps)
      .where(eq(enrichmentSteps.runId, runId))
      .orderBy(asc(enrichmentSteps.createdAt), asc(enrichmentSteps.id));
    return rows.map(toStep);
  }

  async findStep(stepRowId: string): Promise<StepRecord | undefined> {
    const [row] = await this.x.select().from(enrichmentSteps).where(eq(enrichmentSteps.id, stepRowId));
    return row ? toStep(row) : undefined;
  }

  async latestOutputs(businessId: string): Promise<Map<EnrichmentStepId, StepOutput>> {
    const rows = await this.x
      .selectDistinctOn([enrichmentSteps.step], {
        step: enrichmentSteps.step,
        finishedAt: enrichmentSteps.finishedAt,
        inputHash: enrichmentSteps.inputHash,
        outputRef: enrichmentSteps.outputRef,
      })
      .from(enrichmentSteps)
      .where(
        and(
          eq(enrichmentSteps.businessId, businessId),
          eq(enrichmentSteps.status, 'done'),
          isNotNull(enrichmentSteps.finishedAt),
        ),
      )
      .orderBy(enrichmentSteps.step, desc(enrichmentSteps.finishedAt));
    return new Map(
      rows.map((r) => [
        r.step,
        { finishedAt: r.finishedAt as Date, inputHash: r.inputHash, outputRef: r.outputRef },
      ]),
    );
  }

  async latestOutputsMany(
    businessIds: readonly string[],
  ): Promise<Map<string, Map<EnrichmentStepId, StepOutput>>> {
    const result = new Map<string, Map<EnrichmentStepId, StepOutput>>();
    if (businessIds.length === 0) return result;
    const rows = await this.x
      .selectDistinctOn([enrichmentSteps.businessId, enrichmentSteps.step], {
        businessId: enrichmentSteps.businessId,
        step: enrichmentSteps.step,
        finishedAt: enrichmentSteps.finishedAt,
        inputHash: enrichmentSteps.inputHash,
        outputRef: enrichmentSteps.outputRef,
      })
      .from(enrichmentSteps)
      .where(
        and(
          inArray(enrichmentSteps.businessId, [...businessIds]),
          eq(enrichmentSteps.status, 'done'),
          isNotNull(enrichmentSteps.finishedAt),
        ),
      )
      .orderBy(enrichmentSteps.businessId, enrichmentSteps.step, desc(enrichmentSteps.finishedAt));
    for (const r of rows) {
      const outputs = result.get(r.businessId) ?? new Map<EnrichmentStepId, StepOutput>();
      outputs.set(r.step, {
        finishedAt: r.finishedAt as Date,
        inputHash: r.inputHash,
        outputRef: r.outputRef,
      });
      result.set(r.businessId, outputs);
    }
    return result;
  }

  async monthSpendUsd(organizationId: string, at: Date): Promise<number> {
    const { start, end } = monthRange(at);
    const [row] = await this.x
      .select({
        spent: sql<string>`coalesce(sum(CASE WHEN ${enrichmentRuns.status} IN ('queued', 'running')
          THEN greatest(${enrichmentRuns.estimatedUsd}, ${enrichmentRuns.costUsd}) ELSE ${enrichmentRuns.costUsd} END), 0)`,
      })
      .from(enrichmentRuns)
      .where(
        and(
          eq(enrichmentRuns.triggeredByOrgId, organizationId),
          sql`${enrichmentRuns.createdAt} >= ${start.toISOString()}`,
          lt(enrichmentRuns.createdAt, end),
        ),
      );
    return Number(row?.spent ?? 0);
  }

  async markRunning(runId: string, at: Date): Promise<boolean> {
    const rows = await this.x
      .update(enrichmentRuns)
      .set({ status: 'running', startedAt: at })
      .where(and(eq(enrichmentRuns.id, runId), eq(enrichmentRuns.status, 'queued')))
      .returning({ id: enrichmentRuns.id });
    return rows.length > 0;
  }

  async claimStep(stepRowId: string, at: Date, jobId: string): Promise<StepRecord | undefined> {
    const [row] = await this.x
      .update(enrichmentSteps)
      .set({
        status: 'running',
        heartbeatAt: at,
        jobId,
        notBefore: null,
        startedAt: sql`coalesce(${enrichmentSteps.startedAt}, ${at.toISOString()}::timestamptz)`,
        attempt: sql`${enrichmentSteps.attempt} + 1`,
      })
      .where(
        and(
          eq(enrichmentSteps.id, stepRowId),
          eq(enrichmentSteps.status, 'queued'),
          or(isNull(enrichmentSteps.notBefore), lte(enrichmentSteps.notBefore, at)),
          dependenciesSettled,
        ),
      )
      .returning();
    return row ? toStep(row) : undefined;
  }

  async deferStep(stepRowId: string, until: Date): Promise<void> {
    await this.x
      .update(enrichmentSteps)
      .set({ notBefore: until })
      .where(and(eq(enrichmentSteps.id, stepRowId), eq(enrichmentSteps.status, 'queued')));
  }

  async heartbeat(stepRowId: string, at: Date): Promise<void> {
    await this.x
      .update(enrichmentSteps)
      .set({ heartbeatAt: at })
      .where(and(eq(enrichmentSteps.id, stepRowId), eq(enrichmentSteps.status, 'running')));
  }

  async releaseStep(
    stepRowId: string,
    error: string | null,
    _at: Date,
    options: { readonly refund?: boolean; readonly notBefore?: Date } = {},
  ): Promise<StepRecord | undefined> {
    const [row] = await this.x
      .update(enrichmentSteps)
      .set({
        status: 'queued',
        error,
        heartbeatAt: null,
        jobId: null,
        notBefore: options.notBefore ?? null,
        ...(options.refund ? { attempt: sql`greatest(${enrichmentSteps.attempt} - 1, 0)` } : {}),
      })
      .where(and(eq(enrichmentSteps.id, stepRowId), eq(enrichmentSteps.status, 'running')))
      .returning();
    return row ? toStep(row) : undefined;
  }

  async completeStep(stepRowId: string, completion: StepCompletion, at: Date): Promise<boolean> {
    const [row] = await this.x
      .update(enrichmentSteps)
      .set({
        status: completion.status,
        costUsd: completion.costUsd,
        finishedAt: at,
        heartbeatAt: null,
        jobId: null,
        skipReason: completion.status === 'skipped' ? completion.reason : null,
        error: completion.status === 'failed' ? completion.error : null,
        outputRef: completion.status === 'done' ? { ...completion.outputRef } : null,
      })
      .where(and(eq(enrichmentSteps.id, stepRowId), eq(enrichmentSteps.status, 'running')))
      .returning({ runId: enrichmentSteps.runId });
    if (!row) return false;
    const changed = completion.status === 'done' ? [...completion.changedFields] : [];
    await this.x
      .update(enrichmentRuns)
      .set({
        costUsd: sql`${enrichmentRuns.costUsd} + ${completion.costUsd}`,
        changedFields: sql`ARRAY(SELECT DISTINCT f FROM unnest(${enrichmentRuns.changedFields} || ${textArray(changed)}) AS f ORDER BY f)`,
      })
      .where(eq(enrichmentRuns.id, row.runId));
    return true;
  }

  async skipSteps(stepRowIds: readonly string[], reason: EnrichmentSkipReason, at: Date): Promise<void> {
    if (stepRowIds.length === 0) return;
    await this.x
      .update(enrichmentSteps)
      .set({ status: 'skipped', skipReason: reason, finishedAt: at, heartbeatAt: null })
      .where(
        and(
          inArray(enrichmentSteps.id, [...stepRowIds]),
          inArray(enrichmentSteps.status, ['queued', 'running']),
        ),
      );
  }

  async finishRun(runId: string, status: EnrichmentRunStatus, at: Date, error: string | null = null) {
    const rows = await this.x
      .update(enrichmentRuns)
      .set({ status, finishedAt: at, error })
      .where(and(eq(enrichmentRuns.id, runId), inArray(enrichmentRuns.status, OPEN)))
      .returning({ id: enrichmentRuns.id });
    return rows.length > 0;
  }

  async staleRunningSteps(before: Date, limit: number): Promise<StepRecord[]> {
    const rows = await this.x
      .select()
      .from(enrichmentSteps)
      .where(
        and(
          eq(enrichmentSteps.status, 'running'),
          or(lt(enrichmentSteps.heartbeatAt, before), isNull(enrichmentSteps.heartbeatAt)),
        ),
      )
      .limit(limit);
    return rows.map(toStep);
  }

  async idleQueuedSteps(before: Date, limit: number): Promise<StepRecord[]> {
    const rows = await this.x
      .select({ step: enrichmentSteps })
      .from(enrichmentSteps)
      .innerJoin(enrichmentRuns, eq(enrichmentRuns.id, enrichmentSteps.runId))
      .where(
        and(
          eq(enrichmentSteps.status, 'queued'),
          eq(enrichmentRuns.status, 'running'),
          lt(enrichmentSteps.updatedAt, before),
          // Waiting on a dependency or a delay is not a lost job.
          or(isNull(enrichmentSteps.notBefore), lt(enrichmentSteps.notBefore, before)),
          dependenciesSettled,
        ),
      )
      .limit(limit);
    return rows.map((r) => toStep(r.step));
  }

  async idleOpenRuns(before: Date, limit: number): Promise<RunRecord[]> {
    const rows = await this.x
      .select()
      .from(enrichmentRuns)
      .where(and(inArray(enrichmentRuns.status, OPEN), lt(enrichmentRuns.updatedAt, before)))
      .orderBy(asc(enrichmentRuns.updatedAt))
      .limit(limit);
    return rows.map(toRun);
  }

  async countRunsSince(organizationId: string, trigger: EnrichmentTrigger, since: Date): Promise<number> {
    const [row] = await this.x
      .select({ n: sql<number>`count(*)::int` })
      .from(enrichmentRuns)
      .where(
        and(
          eq(enrichmentRuns.triggeredByOrgId, organizationId),
          eq(enrichmentRuns.trigger, trigger),
          sql`${enrichmentRuns.createdAt} >= ${since.toISOString()}::timestamptz`,
        ),
      );
    return row?.n ?? 0;
  }

  async trackingOrganizations(): Promise<string[]> {
    const rows = await this.x.selectDistinct({ id: orgBusinesses.organizationId }).from(orgBusinesses);
    return rows.map((r) => r.id);
  }

  async refreshCandidates(
    organizationId: string,
    steps: readonly { readonly step: EnrichmentStepId; readonly staleBefore: Date }[],
    limit: number,
  ): Promise<string[]> {
    if (steps.length === 0) return [];
    const stale = sql`EXISTS (
      SELECT 1 FROM unnest(${textArray(steps.map((s) => s.step))},
        ${timestampArray(steps.map((s) => s.staleBefore))}) AS t(step, stale_before)
      WHERE NOT EXISTS (SELECT 1 FROM ${enrichmentSteps} es WHERE es.business_id = ${orgBusinesses.businessId}
        AND es.step = t.step AND es.status = 'done' AND es.finished_at >= t.stale_before))`;
    const lastRun = sql`(SELECT max(r.created_at) FROM ${enrichmentRuns} r
      WHERE r.business_id = ${orgBusinesses.businessId} AND r.triggered_by_org_id = ${organizationId})`;
    const rows = await this.x
      .select({ id: orgBusinesses.businessId })
      .from(orgBusinesses)
      .innerJoin(businesses, eq(businesses.id, orgBusinesses.businessId))
      .where(
        and(
          eq(orgBusinesses.organizationId, organizationId),
          isNull(businesses.mergedIntoId),
          sql`NOT EXISTS (SELECT 1 FROM ${enrichmentRuns} r WHERE r.business_id = ${orgBusinesses.businessId}
            AND r.triggered_by_org_id = ${organizationId} AND r.status IN ('queued', 'running'))`,
          stale,
        ),
      )
      // Least recently attempted first: a business that never gets anywhere does not hog every night.
      .orderBy(sql`${lastRun} ASC NULLS FIRST`, asc(orgBusinesses.businessId))
      .limit(limit);
    return rows.map((r) => r.id);
  }
}
