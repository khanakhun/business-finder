import {
  BudgetExceededError,
  type Clock,
  DiscoveryBusinessFound,
  DiscoveryRunCompleted,
  DomainError,
  ExternalServiceError,
  type ProviderQuery,
  RateLimitedError,
} from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import {
  IngestBatchCommand,
  ORG_BUSINESS_REPOSITORY,
  type OrgBusinessRepository,
} from '../../business-graph/index.ts';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { EventRecorder } from '../../platform/events/event-recorder.ts';
import { LOGGER } from '../../platform/logging/logger.ts';
import { isTerminal } from '../domain/run-state-machine.ts';
import { ProviderCostEstimator, ProviderQueryBuilder } from './discovery.services.ts';
import { childTiles, dedupeKey, initialTiles, MAX_RUN_TASKS, profileFor } from './planner.ts';
import { ProviderRegistry } from './provider-registry.ts';
import {
  DISCOVERY_RUN_REPOSITORY,
  type DiscoveryRunRepository,
  type NewTask,
  RUN_PROGRESS,
  RUN_QUEUE,
  type RunProgress,
  type RunQueue,
  type RunRecord,
  type TaskRecord,
} from './run-ports.ts';

/** Fetch attempts per task (BullMQ retries; the provider decorator also retries within an attempt). */
export const MAX_TASK_ATTEMPTS = 3;
/** Heartbeat of a running call; the reconciler treats a task silent for STALE_AFTER_MS (2 min) as abandoned. */
export const HEARTBEAT_MS = 30_000;
const ENQUEUE_CHUNK = 500;

/** Errors worth another attempt of the whole task (rate limits, outages); others fail it now. */
const transient = (error: unknown) =>
  error instanceof RateLimitedError ||
  (error instanceof ExternalServiceError && error.details?.retryable !== false) ||
  !(error instanceof DomainError);

/**
 * Discovery run steps (BF-020), each idempotent and driven by database state (ADR-0006):
 * plan → fetch (reserve budget, call the provider, record usage, split saturated tiles, continue pages) →
 * ingest (BF-016) + track → finalize when no open work remains.
 */
@Injectable()
export class RunOrchestrator {
  constructor(
    @Inject(DISCOVERY_RUN_REPOSITORY) private readonly runs: DiscoveryRunRepository,
    @Inject(RUN_QUEUE) private readonly queue: RunQueue,
    @Inject(RUN_PROGRESS) private readonly progress: RunProgress,
    private readonly registry: ProviderRegistry,
    private readonly queries: ProviderQueryBuilder,
    private readonly estimator: ProviderCostEstimator,
    private readonly ingestBatch: IngestBatchCommand,
    @Inject(ORG_BUSINESS_REPOSITORY) private readonly orgBusinesses: OrgBusinessRepository,
    private readonly events: EventRecorder,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Tiles the area per provider and creates the root tasks (re-planning adds nothing already planned). */
  async plan(runId: string): Promise<void> {
    const run = await this.runs.getRun(runId);
    if (!run || isTerminal(run.status)) return;
    if (run.status === 'queued' && !(await this.runs.startRun(runId, this.clock.now()))) return;
    if (run.plannedAt) return; // a duplicate plan job; lost fetch jobs are the reconciler's business
    const tasks: NewTask[] = [];
    for (const providerId of run.providers) {
      const provider = this.registry.get(providerId);
      if (!provider) {
        this.logger.warn({ runId, provider: providerId }, 'discovery provider not registered; skipped');
        continue;
      }
      const profile = profileFor(provider.capabilities, run.options.tileStrategy);
      const tiles = initialTiles(run.areaGeometry, profile);
      const queries = await this.queries.buildForTiles(
        run.organizationId,
        providerId,
        run.intent,
        tiles,
        run.options.fieldTier,
      );
      tasks.push(...queries.map((query) => this.newTask(query, 0, null)));
    }
    // Root tasks and the planned mark commit together: the run cannot be finalized half-planned.
    const created = await this.runs.addTasks(runId, tasks, { planned: true });
    for (let i = 0; i < created.length; i += ENQUEUE_CHUNK) {
      await Promise.all(
        created.slice(i, i + ENQUEUE_CHUNK).map((task) => this.queue.fetch(task, run.organizationId)),
      );
    }
    this.logger.info({ runId, tasks: created.length }, 'discovery run planned');
    await this.progress.progressed(runId);
    await this.finalizeIfDone(runId);
  }

  /** One provider call for a task: budget reservation first, actual cost after. */
  async fetch(runId: string, taskId: string, signal: AbortSignal): Promise<void> {
    const [run, task] = await Promise.all([this.runs.getRun(runId), this.runs.getTask(taskId)]);
    if (!run || !task) return;
    if (run.status !== 'running') {
      await this.runs.skipTask(task, run.status === 'cancelled' ? 'cancelled' : 'run ended');
      return;
    }
    const claimed = await this.runs.claimTask(taskId, this.clock.now());
    if (!claimed) return; // done, skipped, or another worker has it
    if (run.budgetExhausted || run.counts.recordsFetched >= run.options.maxResults) {
      await this.runs.skipTask(claimed, run.budgetExhausted ? 'budget' : 'result cap reached');
      await this.finalizeIfDone(runId);
      return;
    }
    const provider = this.registry.get(claimed.provider);
    if (!provider) {
      await this.runs.failTask(claimed, 'provider unavailable');
      await this.finalizeIfDone(runId);
      return;
    }
    const sku = provider.skuFor(claimed.query);
    const reservation = (
      await this.estimator.estimateCalls(run.organizationId, provider.id, [{ sku, calls: 1 }])
    ).totalUsd;
    if (!(await this.runs.reserve(claimed, reservation))) {
      await this.stopForBudget(run, claimed, 'budget');
      return;
    }
    let page: Awaited<ReturnType<typeof provider.fetchPage>>;
    const beat = setInterval(() => {
      this.runs.heartbeat(taskId, this.clock.now()).catch((error: unknown) => {
        this.logger.warn({ err: error, runId, taskId }, 'discovery heartbeat failed');
      });
    }, HEARTBEAT_MS);
    beat.unref();
    try {
      page = await provider.fetchPage(claimed.query, {
        organizationId: run.organizationId,
        credential: null,
        signal,
      });
    } catch (error) {
      // Every path below (requeue, fail, skip) gives the task's reservation back.
      await this.handleFetchError(run, claimed, error, signal);
      return;
    } finally {
      clearInterval(beat);
    }
    // Follow-ups commit with the completion, so a crash cannot lose a split or the next page.
    const followUps: NewTask[] = [];
    const profile = profileFor(provider.capabilities, run.options.tileStrategy);
    if (page.saturated && claimed.depth < profile.maxDepth) {
      for (const tile of childTiles(claimed.query.tile, run.areaGeometry)) {
        const { pageToken: _token, ...base } = claimed.query;
        followUps.push(this.newTask({ ...base, tile, pageNumber: 0 }, claimed.depth + 1, claimed.id));
      }
    }
    if (page.nextPageToken && claimed.query.pageNumber + 1 < provider.maxPages(claimed.query)) {
      const next = {
        ...claimed.query,
        pageToken: page.nextPageToken,
        pageNumber: claimed.query.pageNumber + 1,
      };
      const notBefore = page.pollAfterMs ? new Date(this.clock.now().getTime() + page.pollAfterMs) : null;
      followUps.push({ ...this.newTask(next, claimed.depth, claimed.id), notBefore });
    }
    if (run.counts.tasksTotal + followUps.length > MAX_RUN_TASKS) {
      // DECISION(BF-020): past the task cap, saturated tiles stay unsplit (results may be missed) rather
      // than letting one run grow without bound; the soft check may overshoot by in-flight fetches.
      this.logger.warn({ runId, taskId, dropped: followUps.length }, 'discovery run task cap reached');
      followUps.length = 0;
    }
    const { accepted, created } = await this.runs.completeTask(
      claimed,
      { records: page.records, saturated: page.saturated, costUsd: page.callCostUsd ?? 0 },
      followUps,
    );
    if (accepted) {
      await Promise.all(
        created.map((t) =>
          this.queue.fetch(
            t,
            run.organizationId,
            t.notBefore ? Math.max(0, t.notBefore.getTime() - this.clock.now().getTime()) : 0,
          ),
        ),
      );
      if (page.records.length > 0) await this.queue.ingest(runId, claimed.id, run.organizationId);
      await this.progress.progressed(runId);
    }
    await this.finalizeIfDone(runId);
  }

  /** Ingests a fetched page (idempotent per task) and tracks the businesses for the workspace. */
  async ingest(runId: string, taskId: string): Promise<void> {
    const [run, task] = await Promise.all([this.runs.getRun(runId), this.runs.getTask(taskId)]);
    if (!run || !task) return;
    const records = await this.runs.pendingRecords(taskId);
    if (records) {
      const result = await this.ingestBatch.execute(records);
      for (const outcome of result.results) {
        if (outcome.outcome === 'failed') continue;
        const { created } = await this.orgBusinesses.track({
          organizationId: run.organizationId,
          businessId: outcome.businessId,
          addedVia: 'discovery',
          addedRef: runId,
        });
        if (created && run.options.autoEnrich) {
          await this.events.record(DiscoveryBusinessFound, {
            orgId: run.organizationId,
            payload: { runId, businessId: outcome.businessId },
          });
        }
      }
      await this.runs.applyIngest(task, {
        created: result.counts.created,
        merged: result.counts.merged,
        unchanged: result.counts.unchanged,
        possibleDuplicates: result.counts.possible_duplicate,
        failedRecords: result.counts.failed,
      });
    }
    await this.progress.progressed(runId);
    await this.finalizeIfDone(runId);
  }

  /** Ends the run when nothing is left to do; records the completion event in the same transaction. */
  async finalizeIfDone(runId: string): Promise<RunRecord | undefined> {
    const ended = await this.finalizeTx(runId);
    if (ended) await this.progress.finished(ended);
    return ended;
  }

  @Transactional()
  private async finalizeTx(runId: string): Promise<RunRecord | undefined> {
    const ended = await this.runs.finalize(runId, this.clock.now());
    if (ended) await this.recordCompletion(ended);
    return ended;
  }

  async recordCompletion(run: RunRecord): Promise<void> {
    await this.events.record(DiscoveryRunCompleted, {
      orgId: run.organizationId,
      payload: {
        runId: run.id,
        status: run.status,
        reason: run.reason,
        createdBy: run.createdBy,
        counts: run.counts,
        costUsd: run.costUsd,
      },
    });
  }

  private async handleFetchError(
    run: RunRecord,
    task: TaskRecord,
    error: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    if (error instanceof BudgetExceededError) {
      await this.stopForBudget(run, task, 'monthly_budget');
      return;
    }
    if (signal.aborted) {
      await this.runs.skipTask(task, 'cancelled');
      await this.finalizeIfDone(run.id);
      return;
    }
    const code = error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'ERROR';
    if (transient(error) && task.attempt < MAX_TASK_ATTEMPTS) {
      this.logger.warn(
        { runId: run.id, taskId: task.id, provider: task.provider, code, attempt: task.attempt },
        'discovery fetch failed; retrying',
      );
      await this.runs.requeueTask(task.id);
      throw error; // BullMQ retries with backoff
    }
    this.logger.warn(
      { runId: run.id, taskId: task.id, provider: task.provider, code },
      'discovery fetch failed',
    );
    await this.runs.failTask(task, code);
    await this.finalizeIfDone(run.id);
  }

  /** No more spending: this task and every queued one are skipped; in-flight calls finish. */
  private async stopForBudget(
    run: RunRecord,
    task: TaskRecord,
    reason: 'budget' | 'monthly_budget',
  ): Promise<void> {
    await this.runs.markStop(run.id, reason);
    await this.runs.skipTask(task, reason);
    await this.runs.skipQueued(run.id, reason);
    this.logger.info({ runId: run.id, reason }, 'discovery run budget reached');
    await this.finalizeIfDone(run.id);
  }

  private newTask(query: ProviderQuery, depth: number, parentTaskId: string | null): NewTask {
    return {
      provider: query.provider,
      categoryId: query.categoryId,
      query,
      depth,
      parentTaskId,
      dedupeKey: dedupeKey(query),
    };
  }
}
