import { createHash } from 'node:crypto';
import {
  type Clock,
  ConflictError,
  type DiscoveryRun,
  type DiscoveryRunEstimate,
  type DiscoveryRunPage,
  type DiscoveryRunQuery,
  type DiscoveryTaskPage,
  decodeCursor,
  type EstimateDiscoveryRunRequest,
  encodeCursor,
  type MultiPolygon,
  NotFoundError,
  type ProviderId,
  type RunBusinessPage,
  type StartDiscoveryRunRequest,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { areaKm2, asMultiPolygon, GEO_AREA_REPOSITORY, type GeoAreaRepository } from '../../geo/index.ts';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { AuditLogger, WorkspaceDefaults } from '../../workspace/index.ts';
import {
  ProviderCostEstimator,
  ProviderQueryBuilder,
  ProviderSelectionService,
} from './discovery.services.ts';
import { initialTiles, MAX_RUN_TASKS, profileFor } from './planner.ts';
import { ProviderRegistry } from './provider-registry.ts';
import { RunOrchestrator } from './run-orchestrator.ts';
import {
  type After,
  DISCOVERY_RUN_REPOSITORY,
  type DiscoveryRunRepository,
  RUN_PROGRESS,
  RUN_QUEUE,
  type RunProgress,
  type RunQueue,
  type RunRecord,
  type TaskRecord,
} from './run-ports.ts';

/** Largest area one run may cover (a region, not a country). */
const MAX_AREA_KM2 = 25_000;
/** Saturated tiles may split this many levels: the worst case multiplies calls (4 + 16 + 64 children). */
const SATURATION_FACTOR = 5;
/** Queued or running runs per workspace. */
export const MAX_ACTIVE_RUNS = 3;

const tooManyTasks = (tasks: number) =>
  new ValidationError('Too many searches for one run: narrow the area or ask for fewer categories.', [
    { path: ['area'], message: `About ${tasks} tasks; at most ${MAX_RUN_TASKS}` },
  ]);

/** Same request, same hash (parsed requests have a stable key order). */
const requestHashOf = (request: StartDiscoveryRunRequest) =>
  createHash('sha256').update(JSON.stringify(request)).digest('hex');

const workspaceOf = (auth: AuthContext): string => {
  if (!auth.orgId) throw new Error('Discovery route reached without an active workspace');
  return auth.orgId;
};

export function toRun(run: RunRecord): DiscoveryRun {
  return {
    id: run.id,
    status: run.status,
    reason: run.reason,
    intent: run.intent,
    areaId: run.areaId,
    providers: [...run.providers],
    options: run.options,
    budgetUsd: run.budgetUsd,
    costUsd: run.costUsd,
    counts: run.counts,
    createdBy: run.createdBy,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
  };
}

const toTask = (task: TaskRecord) => ({
  id: task.id,
  provider: task.provider,
  categoryId: task.categoryId,
  tile: task.query.tile,
  depth: task.depth,
  pageNumber: task.query.pageNumber,
  status: task.status,
  attempt: task.attempt,
  records: task.records,
  saturated: task.saturated,
  costUsd: task.costUsd,
  error: task.error,
  createdAt: task.createdAt.toISOString(),
});

async function afterOf(cursor: string | undefined, withAt = false): Promise<After | undefined> {
  if (!cursor) return undefined;
  const data = await decodeCursor(cursor);
  const [at] = data.sort;
  const atOk =
    !withAt || (typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at));
  if (!z.uuid().safeParse(data.id).success || !atOk) {
    throw new ValidationError('Invalid cursor.', [{ path: ['cursor'], message: 'Invalid cursor' }]);
  }
  return withAt ? { id: data.id, at: at as string } : { id: data.id };
}

const cursorOf = (next: After | null) =>
  next ? encodeCursor({ sort: next.at ? [next.at] : [], id: next.id }) : null;

/** The run's area as a polygon: a stored area of the workspace, or a drawn geometry, within size limits. */
async function resolveArea(
  areas: GeoAreaRepository,
  organizationId: string,
  area: EstimateDiscoveryRunRequest['area'],
): Promise<{ areaId: string | null; geometry: MultiPolygon }> {
  const geometry =
    'areaId' in area ? await areas.geometryOf(area.areaId, organizationId) : asMultiPolygon(area.geometry);
  if (!geometry) throw new NotFoundError('GeoArea', 'areaId' in area ? area.areaId : 'geometry');
  const km2 = areaKm2(geometry);
  if (!(km2 > 0) || km2 > MAX_AREA_KM2) {
    throw new ValidationError('The area is empty or too large for one run.', [
      { path: ['area'], message: `Between 0 and ${MAX_AREA_KM2} km²` },
    ]);
  }
  return { areaId: 'areaId' in area ? area.areaId : null, geometry };
}

@Injectable()
export class DiscoveryRunPlanner {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly selection: ProviderSelectionService,
    private readonly queries: ProviderQueryBuilder,
    private readonly estimator: ProviderCostEstimator,
    private readonly defaults: WorkspaceDefaults,
    @Inject(GEO_AREA_REPOSITORY) private readonly areas: GeoAreaRepository,
  ) {}

  /** Providers, tiles, tasks, calls and cost ranges for a request (no side effects). */
  async estimate(organizationId: string, request: EstimateDiscoveryRunRequest) {
    const settings = await this.defaults.discoverySettings(organizationId);
    const budgetUsd = request.budgetUsd ?? settings.runBudgetUsd;
    const { areaId, geometry } = await resolveArea(this.areas, organizationId, request.area);
    const tileKind = 'BBox' as const;
    const selection = await this.selection.select(organizationId, {
      keywords: Boolean(request.intent.keywords),
      categories: request.intent.categoryIds.length > 0,
      tile: tileKind,
    });
    const candidates = request.providers
      ? request.providers.filter((id) => selection.selected.includes(id))
      : [...selection.selected];
    const excluded: DiscoveryRunEstimate['excluded'] = [
      ...selection.excluded.map((e) => ({ provider: e.id, reason: e.reason })),
      ...(request.providers ?? [])
        .filter((id) => !selection.selected.includes(id) && !selection.excluded.some((e) => e.id === id))
        .map((id) => ({ provider: id, reason: 'unknown' })),
    ];
    const providers: DiscoveryRunEstimate['providers'] = [];
    const used: ProviderId[] = [];
    let plannedTasks = 0;
    for (const providerId of candidates) {
      const provider = this.registry.get(providerId);
      if (!provider) continue;
      const profile = profileFor(provider.capabilities, request.options.tileStrategy);
      const tiles = initialTiles(geometry, profile);
      // Checked before building queries, so an oversized request costs no more than its tiling.
      const lowerBound = plannedTasks + tiles.length * Math.max(1, request.intent.categoryIds.length);
      if (lowerBound > MAX_RUN_TASKS) throw tooManyTasks(lowerBound);
      const queries = await this.queries.buildForTiles(
        organizationId,
        providerId,
        request.intent,
        tiles,
        request.options.fieldTier,
      );
      if (queries.length === 0) {
        excluded.push({ provider: providerId, reason: 'no_queries' });
        continue;
      }
      plannedTasks += queries.length;
      if (plannedTasks > MAX_RUN_TASKS) throw tooManyTasks(plannedTasks);
      const bySku = new Map<string, { tasks: number; maxPages: number }>();
      for (const query of queries) {
        const sku = provider.skuFor(query);
        const entry = bySku.get(sku) ?? { tasks: 0, maxPages: 1 };
        bySku.set(sku, {
          tasks: entry.tasks + 1,
          maxPages: Math.max(entry.maxPages, Math.min(provider.maxPages(query), 10)),
        });
      }
      const splits = profile.maxDepth > 0 ? SATURATION_FACTOR : 1;
      const callsFor = (pick: 'min' | 'expected' | 'max') =>
        [...bySku].map(([sku, { tasks, maxPages }]) => ({
          sku,
          calls:
            pick === 'min'
              ? tasks
              : pick === 'expected'
                ? Math.ceil(tasks * Math.min(2, maxPages))
                : tasks * maxPages * splits,
        }));
      const [min, expected, max] = await Promise.all(
        (['min', 'expected', 'max'] as const).map((pick) =>
          this.estimator.estimateCalls(organizationId, providerId, callsFor(pick)),
        ),
      );
      const sum = (lines: Array<{ calls: number }>) => lines.reduce((n, l) => n + l.calls, 0);
      providers.push({
        provider: providerId,
        tiles: tiles.length,
        tasks: queries.length,
        calls: { min: sum(callsFor('min')), expected: sum(callsFor('expected')), max: sum(callsFor('max')) },
        costUsd: { min: min?.totalUsd ?? 0, expected: expected?.totalUsd ?? 0, max: max?.totalUsd ?? 0 },
        results: {
          min: 0,
          max: Math.min(
            request.options.maxResults,
            queries.length * provider.capabilities.maxResultsPerQuery * splits,
          ),
        },
      });
      used.push(providerId);
    }
    const total = (key: 'min' | 'expected' | 'max', field: 'calls' | 'costUsd') =>
      Math.round(providers.reduce((n, p) => n + p[field][key], 0) * 1e6) / 1e6;
    const warnings: DiscoveryRunEstimate['warnings'] = [];
    if (providers.length === 0)
      warnings.push({ code: 'NO_PROVIDERS', message: 'No provider can serve this search.' });
    if (
      (request.options.fieldTier ?? settings.googleFieldTier) === 'enterprise' &&
      used.includes('google_places')
    ) {
      warnings.push({
        code: 'GOOGLE_ENTERPRISE',
        message: 'Google Enterprise fields selected: about $35 per 1,000 calls.',
      });
    }
    if (total('expected', 'costUsd') > budgetUsd) {
      warnings.push({
        code: 'BUDGET_BELOW_ESTIMATE',
        message: 'The budget is below the expected cost: the run may stop early.',
      });
    }
    return {
      estimate: {
        providers,
        excluded,
        totals: {
          tasks: providers.reduce((n, p) => n + p.tasks, 0),
          calls: {
            min: total('min', 'calls'),
            expected: total('expected', 'calls'),
            max: total('max', 'calls'),
          },
          costUsd: {
            min: total('min', 'costUsd'),
            expected: total('expected', 'costUsd'),
            max: total('max', 'costUsd'),
          },
        },
        budgetUsd,
        warnings,
      } satisfies DiscoveryRunEstimate,
      areaId,
      geometry,
      providers: used,
    };
  }
}

@Injectable()
export class EstimateDiscoveryRunQuery {
  constructor(private readonly planner: DiscoveryRunPlanner) {}

  async execute(auth: AuthContext, request: EstimateDiscoveryRunRequest): Promise<DiscoveryRunEstimate> {
    return (await this.planner.estimate(workspaceOf(auth), request)).estimate;
  }
}

@Injectable()
export class StartDiscoveryRunCommand {
  constructor(
    private readonly planner: DiscoveryRunPlanner,
    @Inject(DISCOVERY_RUN_REPOSITORY) private readonly runs: DiscoveryRunRepository,
    @Inject(RUN_QUEUE) private readonly queue: RunQueue,
    private readonly audit: AuditLogger,
  ) {}

  async execute(
    auth: AuthContext,
    request: StartDiscoveryRunRequest,
    idempotencyKey: string | null,
  ): Promise<{ run: DiscoveryRun; created: boolean }> {
    const organizationId = workspaceOf(auth);
    const { estimate, areaId, geometry, providers } = await this.planner.estimate(organizationId, request);
    if (providers.length === 0) {
      throw new ConflictError('No discovery provider can serve this search.', {
        details: { reason: 'NO_PROVIDERS' },
      });
    }
    const { run, created } = await this.create(auth, organizationId, request, idempotencyKey, {
      areaId,
      geometry,
      providers,
      budgetUsd: estimate.budgetUsd,
    });
    // After commit: if this fails, the reconciler plans runs left queued.
    if (created) await this.queue.plan(run.id, organizationId);
    return { run: toRun(run), created };
  }

  @Transactional()
  private async create(
    auth: AuthContext,
    organizationId: string,
    request: StartDiscoveryRunRequest,
    idempotencyKey: string | null,
    plan: { areaId: string | null; geometry: MultiPolygon; providers: ProviderId[]; budgetUsd: number },
  ) {
    const requestHash = requestHashOf(request);
    // Serializes starts of the workspace, so the retry check and the limit see every committed run.
    const active = await this.runs.activeRunCount(organizationId);
    if (idempotencyKey) {
      const existing = await this.runs.findByIdempotencyKey(organizationId, idempotencyKey);
      if (existing && existing.requestHash !== requestHash) {
        throw new ConflictError('This Idempotency-Key was used for a different run request.', {
          details: { reason: 'IDEMPOTENCY_KEY_REUSED' },
        });
      }
      if (existing) return { run: existing, created: false };
    }
    if (active >= MAX_ACTIVE_RUNS) {
      throw new ConflictError(`At most ${MAX_ACTIVE_RUNS} discovery runs can be active at once.`, {
        details: { reason: 'TOO_MANY_ACTIVE_RUNS', limit: MAX_ACTIVE_RUNS },
      });
    }
    const result = await this.runs.createRun({
      organizationId,
      createdBy: auth.userId,
      intent: request.intent,
      areaId: plan.areaId,
      areaGeometry: plan.geometry,
      providers: plan.providers,
      options: request.options,
      budgetUsd: plan.budgetUsd,
      idempotencyKey,
      requestHash,
    });
    if (result.created) {
      await this.audit.record({
        auth,
        action: 'discovery.run_started',
        entityType: 'discovery_run',
        entityId: result.run.id,
        metadata: {
          providers: plan.providers,
          budgetUsd: plan.budgetUsd,
          categories: request.intent.categoryIds.length,
        },
      });
    }
    return result;
  }
}

@Injectable()
export class CancelDiscoveryRunCommand {
  constructor(
    @Inject(DISCOVERY_RUN_REPOSITORY) private readonly runs: DiscoveryRunRepository,
    @Inject(RUN_QUEUE) private readonly queue: RunQueue,
    @Inject(RUN_PROGRESS) private readonly progress: RunProgress,
    private readonly orchestrator: RunOrchestrator,
    private readonly audit: AuditLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(auth: AuthContext, runId: string): Promise<DiscoveryRun> {
    const organizationId = workspaceOf(auth);
    const cancelled = await this.cancel(auth, organizationId, runId);
    if (!cancelled) {
      const run = await this.runs.getRun(runId, organizationId);
      if (!run) throw new NotFoundError('DiscoveryRun', runId);
      return toRun(run); // already finished: cancelling is a no-op
    }
    // In-flight calls stop at their next checkpoint (cooperative cancellation).
    await this.queue.cancelFetches(cancelled.running);
    await this.progress.finished(cancelled.run);
    return toRun(cancelled.run);
  }

  @Transactional()
  private async cancel(auth: AuthContext, organizationId: string, runId: string) {
    const result = await this.runs.cancel(runId, organizationId, this.clock.now());
    if (result) {
      await this.orchestrator.recordCompletion(result.run);
      await this.audit.record({
        auth,
        action: 'discovery.run_cancelled',
        entityType: 'discovery_run',
        entityId: runId,
      });
    }
    return result;
  }
}

@Injectable()
export class DiscoveryRunQueries {
  constructor(@Inject(DISCOVERY_RUN_REPOSITORY) private readonly runs: DiscoveryRunRepository) {}

  async list(auth: AuthContext, query: DiscoveryRunQuery): Promise<DiscoveryRunPage> {
    const after = await afterOf(query.cursor);
    const page = await this.runs.listRuns(workspaceOf(auth), {
      limit: query.limit,
      ...(query.status ? { status: query.status } : {}),
      ...(after ? { after } : {}),
    });
    return { items: page.items.map(toRun), nextCursor: await cursorOf(page.next) };
  }

  async get(auth: AuthContext, runId: string): Promise<DiscoveryRun> {
    return toRun(await this.owned(auth, runId));
  }

  async tasks(
    auth: AuthContext,
    runId: string,
    query: { limit: number; cursor?: string | undefined },
  ): Promise<DiscoveryTaskPage> {
    await this.owned(auth, runId);
    const after = await afterOf(query.cursor);
    const page = await this.runs.listTasks(runId, { limit: query.limit, ...(after ? { after } : {}) });
    return { items: page.items.map(toTask), nextCursor: await cursorOf(page.next) };
  }

  async businesses(
    auth: AuthContext,
    runId: string,
    query: { limit: number; cursor?: string | undefined },
  ): Promise<RunBusinessPage> {
    await this.owned(auth, runId);
    const after = await afterOf(query.cursor, true);
    const page = await this.runs.runBusinesses(workspaceOf(auth), runId, {
      limit: query.limit,
      ...(after ? { after } : {}),
    });
    return { items: page.items, nextCursor: await cursorOf(page.next) };
  }

  private async owned(auth: AuthContext, runId: string): Promise<RunRecord> {
    const run = await this.runs.getRun(runId, workspaceOf(auth));
    if (!run) throw new NotFoundError('DiscoveryRun', runId);
    return run;
  }
}
