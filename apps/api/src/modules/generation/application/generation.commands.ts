import { createHash } from 'node:crypto';
import {
  type Clock,
  ConflictError,
  type CreateGenerationBatchRequest,
  CreateGenerationBatchRequestSchema,
  type EngineId,
  NotFoundError,
  newId,
  type UpdateGenerationJobRequest,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { priorityFor, queuePriority } from '../domain/batch.ts';
import type { PagePlanTemplate } from '../domain/brief/page-plan.ts';
import { jobBudget } from '../domain/budget-policy.ts';
import { selectEngine } from '../domain/engine-selection-policy.ts';
import { chainAfter } from '../domain/failover-policy.ts';
import { isCancellable } from '../domain/job-state-machine.ts';
import { PAGE_PLAN_TEMPLATES } from './brief.service.ts';
import {
  CANCEL_SIGNALS,
  type CancelSignals,
  ENGINE_REGISTRY,
  type EngineRegistry,
  GENERATION_QUEUES,
  GENERATION_REPOSITORY,
  GENERATION_SETTINGS,
  type GenerationQueues,
  type GenerationRepository,
  type GenerationSettingsReader,
  type StoredBatch,
  type StoredJob,
  WORKSPACE_BUDGET,
  WORKSPACE_PREPARER,
  type WorkspaceBudget,
  type WorkspacePreparer,
} from './ports.ts';
import { JobTransitions } from './transitions.ts';

export interface GenerationActor {
  readonly organizationId: string;
  readonly userId: string | null;
}

/**
 * The person's commands (BF-039): create a batch (businesses the workspace tracks, engines it allows, budgets
 * within caps, `auto` resolved with its reason), reorder or change waiting jobs, cancel, retry.
 */
@Injectable()
export class GenerationCommands {
  constructor(
    @Inject(GENERATION_REPOSITORY) private readonly repository: GenerationRepository,
    @Inject(ENGINE_REGISTRY) private readonly engines: EngineRegistry,
    @Inject(GENERATION_QUEUES) private readonly queues: GenerationQueues,
    @Inject(GENERATION_SETTINGS) private readonly settings: GenerationSettingsReader,
    @Inject(WORKSPACE_PREPARER) private readonly preparer: WorkspacePreparer,
    @Inject(WORKSPACE_BUDGET) private readonly budget: WorkspaceBudget,
    @Inject(CANCEL_SIGNALS) private readonly cancels: CancelSignals,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly transitions: JobTransitions,
    @Optional() @Inject(PAGE_PLAN_TEMPLATES) private readonly templates?: readonly PagePlanTemplate[],
  ) {}

  /** Creates the batch and its jobs, then starts dispatching; the same `Idempotency-Key` returns the same batch. */
  async createBatch(
    actor: GenerationActor,
    input: CreateGenerationBatchRequest,
    idempotencyKey: string | null,
  ): Promise<{ batch: StoredBatch; created: boolean }> {
    const request = CreateGenerationBatchRequestSchema.parse(input);
    const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    if (idempotencyKey) {
      const existing = await this.repository.batchByIdempotencyKey(actor.organizationId, idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash)
          throw new ConflictError('This Idempotency-Key was used for a different batch.', {
            details: { reason: 'IDEMPOTENCY_KEY_REUSED' },
          });
        return { batch: existing, created: false };
      }
    }
    if ((await this.budget.check(actor.organizationId)) === 'hard')
      throw new ValidationError('The workspace’s monthly AI budget is spent.', [
        { path: ['items'], message: 'AI budget spent', code: 'budget_exceeded' },
      ]);
    const settings = await this.settings.resolve(actor.organizationId);
    const names = await this.repository.trackedBusinesses(
      actor.organizationId,
      request.items.map((item) => item.businessId),
    );
    const problems = request.items.flatMap((item, index) => {
      const out: { path: (string | number)[]; message: string; code: string }[] = [];
      if (!names.has(item.businessId))
        out.push({
          path: ['items', index, 'businessId'],
          message: 'Not a business of this workspace',
          code: 'not_found',
        });
      if (item.engine !== 'auto' && !settings.allowedEngines.includes(item.engine))
        out.push({
          path: ['items', index, 'engine'],
          message: 'Engine not allowed for this workspace',
          code: 'engine',
        });
      if (item.engine !== 'auto' && !this.engines.get(item.engine))
        out.push({ path: ['items', index, 'engine'], message: 'Engine not available here', code: 'engine' });
      return out;
    });
    if (problems.length > 0) throw new ValidationError('Some items cannot be generated.', problems);

    const load = await this.repository.engineLoad(actor.organizationId);
    const candidates = await Promise.all(
      this.engines.list().map(async (engine) => ({
        id: engine.id,
        available: await engine.available(actor.organizationId),
        capabilities: engine.capabilities,
        backlog: load.get(engine.id)?.queued ?? 0,
        running: load.get(engine.id)?.running ?? 0,
      })),
    );
    const locales = request.settings.locales ?? settings.locales;
    const batchId = newId();
    const jobs = [];
    for (const [position, item] of request.items.entries()) {
      const requested =
        item.engine === 'auto' && settings.defaultEngine !== 'auto' ? settings.defaultEngine : item.engine;
      let engine: EngineId;
      let reason: string;
      const budgetCap = item.budgetUsd ?? Math.max(...Object.values(settings.engineBudgetsUsd), 1);
      if (requested === 'auto') {
        const complexity = await this.preparer.estimate(
          { organizationId: actor.organizationId, businessId: item.businessId },
          locales,
        );
        const choice = selectEngine({
          allowed: settings.allowedEngines,
          candidates,
          complexity: {
            pages: complexity.pages,
            items: complexity.items,
            locales: complexity.locales.length,
          },
          budgetUsd: budgetCap,
        });
        if (!choice.engine)
          throw new ValidationError('No engine can take this item.', [
            { path: ['items', position, 'engine'], message: choice.reason, code: 'no_engine' },
          ]);
        engine = choice.engine;
        reason = choice.reason;
      } else {
        engine = requested;
        reason = 'chosen by the person';
      }
      const pagePlanId = item.briefOverrides?.pagePlanId;
      if (pagePlanId && this.templates && !this.templates.some((template) => template.id === pagePlanId))
        throw new ValidationError('Unknown page plan.', [
          {
            path: ['items', position, 'briefOverrides', 'pagePlanId'],
            message: `There is no page plan "${pagePlanId}".`,
            code: 'unknown_page_plan',
          },
        ]);
      jobs.push({
        id: newId(),
        batchId,
        organizationId: actor.organizationId,
        businessId: item.businessId,
        siteId: item.siteId ?? null,
        briefOverrides: item.briefOverrides ?? null,
        position,
        priority: priorityFor(position, request.items.length, item.priority),
        engineRequested: item.engine,
        engineCurrent: engine,
        engineSelectionReason: reason,
        maxAttemptsPerEngine: settings.maxAttemptsPerEngine,
        failoverChain: chainAfter(settings.failoverChain, engine),
        budgetUsd: jobBudget(item.budgetUsd, settings.engineBudgetsUsd[engine]),
      });
    }
    await this.insert(actor, batchId, request, settings, jobs, idempotencyKey, requestHash);
    await this.repository.refreshBatch(batchId, this.clock.now());
    await this.transitions.dispatch(batchId);
    const batch = await this.repository.batchById(batchId);
    if (!batch) throw new NotFoundError('GenerationBatch', batchId);
    return { batch, created: true };
  }

  @Transactional()
  private async insert(
    actor: GenerationActor,
    batchId: string,
    request: ReturnType<typeof CreateGenerationBatchRequestSchema.parse>,
    settings: Awaited<ReturnType<GenerationSettingsReader['resolve']>>,
    jobs: Parameters<GenerationRepository['insertJobs']>[0],
    idempotencyKey: string | null,
    requestHash: string,
  ) {
    const options = request.settings;
    await this.repository.insertBatch({
      id: batchId,
      organizationId: actor.organizationId,
      createdBy: actor.userId,
      name: request.name ?? `Batch of ${request.items.length}`,
      settings: {
        ...settings,
        ...(options.autoPublishPreview !== undefined
          ? { autoPublishPreview: options.autoPublishPreview }
          : {}),
        ...(options.locales ? { locales: options.locales } : {}),
        ...(options.maxParallel ? { maxParallel: options.maxParallel } : {}),
        ...(options.style ? { style: options.style } : {}),
        ...(options.offer ? { offer: options.offer } : {}),
      },
      maxParallel: options.maxParallel ?? null,
      budgetUsd: options.budgetUsd ?? null,
      idempotencyKey,
      requestHash,
    });
    await this.repository.insertJobs(jobs);
  }

  private async job(actor: GenerationActor, jobId: string): Promise<StoredJob> {
    const job = await this.repository.job(actor.organizationId, jobId);
    if (!job) throw new NotFoundError('GenerationJob', jobId);
    return job;
  }

  /** A waiting job's priority or engine (a running one keeps its engine until its attempt ends). */
  async update(actor: GenerationActor, jobId: string, input: UpdateGenerationJobRequest): Promise<StoredJob> {
    const job = await this.job(actor, jobId);
    if (job.status !== 'queued')
      throw new ConflictError('Only a waiting job can be changed.', {
        details: { reason: 'JOB_NOT_WAITING' },
      });
    if (input.engine !== undefined && input.engine !== 'auto') {
      const settings = await this.settings.resolve(actor.organizationId);
      if (!settings.allowedEngines.includes(input.engine) || !this.engines.get(input.engine))
        throw new ValidationError('Engine not available.', [
          { path: ['engine'], message: 'Not allowed', code: 'engine' },
        ]);
      if (input.engine !== job.engineCurrent) {
        // Moved to the other engine's queue (a waiting run is taken back first).
        const taken = job.dispatchedAt
          ? await this.queues.remove(job.engineCurrent, job.id, job.attemptCount + 1)
          : true;
        if (!taken)
          throw new ConflictError('The job is starting: change its engine with a retry.', {
            details: { reason: 'JOB_STARTING' },
          });
        await this.repository.updateJob(job.id, {
          engineRequested: input.engine,
          engineCurrent: input.engine,
          engineSelectionReason: 'chosen by the person',
          failoverChain: chainAfter(settings.failoverChain, input.engine),
          dispatchedAt: null,
        });
      }
    }
    if (input.priority !== undefined) {
      await this.repository.updateJob(job.id, { priority: input.priority });
      const updated = await this.job(actor, jobId);
      if (updated.dispatchedAt)
        await this.queues.reprioritize(
          updated.engineCurrent,
          job.id,
          job.attemptCount + 1,
          queuePriority(input.priority, job.position),
        );
    }
    await this.transitions.dispatch(job.batchId);
    return this.job(actor, jobId);
  }

  /** The batch's waiting jobs in this order (1 first): their priorities follow, waiting runs move in the queues. */
  async reorder(actor: GenerationActor, batchId: string, jobIds: readonly string[]): Promise<void> {
    const batch = await this.repository.batch(actor.organizationId, batchId);
    if (!batch) throw new NotFoundError('GenerationBatch', batchId);
    const jobs = new Map((await this.repository.jobs(batch.id)).map((job) => [job.id, job]));
    if (jobIds.some((id) => !jobs.has(id)))
      throw new ValidationError('Every job must belong to the batch.', [
        { path: ['jobIds'], message: 'Unknown job', code: 'not_found' },
      ]);
    for (const [index, id] of jobIds.entries()) {
      const job = jobs.get(id);
      if (!job || job.status !== 'queued') continue;
      const priority = priorityFor(index, jobIds.length);
      await this.repository.updateJob(id, { priority });
      if (job.dispatchedAt)
        await this.queues.reprioritize(
          job.engineCurrent,
          id,
          job.attemptCount + 1,
          queuePriority(priority, index),
        );
    }
  }

  /** Cancels a job: a waiting one at once, a running one through its abort signal (its attempt then settles). */
  async cancel(actor: GenerationActor, jobId: string): Promise<StoredJob> {
    const job = await this.job(actor, jobId);
    if (!isCancellable(job.status)) {
      if (job.status === 'cancelled') return job;
      throw new ConflictError(`A ${job.status} job cannot be cancelled.`, {
        details: { reason: 'JOB_NOT_CANCELLABLE' },
      });
    }
    await this.repository.updateJob(job.id, { cancelRequestedAt: this.clock.now() });
    if (job.status === 'queued') {
      if (job.dispatchedAt) await this.queues.remove(job.engineCurrent, job.id, job.attemptCount + 1);
      await this.transitions.move(job.id, 'cancelled', {
        errorCode: 'CANCELLED',
        errorMessage: 'Cancelled by a person',
      });
      await this.transitions.dispatch(job.batchId);
    } else {
      await this.cancels.request(job.id);
    }
    return this.job(actor, jobId);
  }

  async cancelBatch(actor: GenerationActor, batchId: string): Promise<void> {
    const batch = await this.repository.batch(actor.organizationId, batchId);
    if (!batch) throw new NotFoundError('GenerationBatch', batchId);
    // Waiting jobs first (so none starts while the running ones stop).
    const jobs = await this.repository.jobs(batch.id);
    for (const job of [...jobs].sort((a, b) => Number(b.status === 'queued') - Number(a.status === 'queued')))
      if (isCancellable(job.status)) await this.cancel(actor, job.id);
  }

  /** A new attempt for a failed, cancelled or needs-review job (on another engine if asked). */
  async retry(actor: GenerationActor, jobId: string, engine?: EngineId): Promise<StoredJob> {
    const job = await this.job(actor, jobId);
    if (!['failed', 'cancelled', 'needs_review'].includes(job.status))
      throw new ConflictError('Only a failed, cancelled or reviewed job can be retried.', {
        details: { reason: 'JOB_NOT_RETRYABLE' },
      });
    const settings = await this.settings.resolve(actor.organizationId);
    const next = engine ?? job.engineCurrent;
    if (!settings.allowedEngines.includes(next) || !this.engines.get(next))
      throw new ValidationError('Engine not available.', [
        { path: ['engine'], message: 'Not allowed', code: 'engine' },
      ]);
    await this.transitions.move(job.id, 'queued', {
      engineCurrent: next,
      engineSelectionReason: engine ? 'chosen by the person (retry)' : job.engineSelectionReason,
      engineAttempts: 0,
      failoverChain: chainAfter(settings.failoverChain, next),
      errorCode: null,
      errorMessage: null,
      cancelRequestedAt: null,
      dispatchedAt: null,
    });
    await this.transitions.dispatch(job.batchId);
    return this.job(actor, jobId);
  }
}
