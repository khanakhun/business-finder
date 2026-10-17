import { createHash } from 'node:crypto';
import { type Clock, type EngineEvent, EngineEventSchema, type EngineId, newId } from '@bf/contracts';
import { type Logger, startSpan } from '@bf/observability';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { queuePriority } from '../domain/batch.ts';
import { canStart, overBudget } from '../domain/budget-policy.ts';
import { decideAfterFailure } from '../domain/failover-policy.ts';
import {
  type AgentEngine,
  type ArtifactStore,
  CANCEL_SIGNALS,
  type CancelSignals,
  ENGINE_REGISTRY,
  type EngineRegistry,
  EVENT_STREAM,
  type EventStream,
  GENERATION_ARTIFACTS,
  GENERATION_LIMITS,
  GENERATION_QUEUES,
  GENERATION_REPOSITORY,
  GENERATION_SETTINGS,
  GENERATION_TELEMETRY,
  type GenerationLimits,
  type GenerationQueues,
  type GenerationRepository,
  type GenerationSettingsReader,
  type GenerationTelemetry,
  LEASE_SEMAPHORE,
  type LeaseSemaphore,
  LIVE_UPDATES,
  type LiveUpdates,
  type StoredAttempt,
  type StoredJob,
  WORKSPACE_BUDGET,
  WORKSPACE_PREPARER,
  type WorkspaceBudget,
  type WorkspacePreparer,
} from './ports.ts';
import { qualityReportKey } from './quality-report.ts';
import { JobTransitions } from './transitions.ts';

// One attempt of a generation job (BF-039), the Template Method every engine queue runs: take the slots (the
// workspace's for the engine, the deployment's sandbox pool), prepare the workspace, run the engine while its events
// are written in order (every 250 ms or 50 events) and streamed, enforce the budget, the wall time and
// cancellation, heartbeat, then hand the result to the quality step or apply the failover policy. Slots are
// released whatever happens.

const FLUSH_MS = 250;
const FLUSH_EVENTS = 50;
const LEASE_TTL_MS = 60_000;

export type RunOutcome = 'skipped' | 'deferred' | 'validating' | 'retrying' | 'failed' | 'cancelled';

class AttemptAborted extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

@Injectable()
export class GenerationRunner {
  constructor(
    @Inject(GENERATION_REPOSITORY) private readonly repository: GenerationRepository,
    @Inject(ENGINE_REGISTRY) private readonly engines: EngineRegistry,
    @Inject(GENERATION_QUEUES) private readonly queues: GenerationQueues,
    @Inject(LEASE_SEMAPHORE) private readonly leases: LeaseSemaphore,
    @Inject(CANCEL_SIGNALS) private readonly cancels: CancelSignals,
    @Inject(EVENT_STREAM) private readonly stream: EventStream,
    @Inject(GENERATION_ARTIFACTS) private readonly artifacts: ArtifactStore,
    @Inject(WORKSPACE_PREPARER) private readonly preparer: WorkspacePreparer,
    @Inject(WORKSPACE_BUDGET) private readonly budget: WorkspaceBudget,
    @Inject(GENERATION_SETTINGS) private readonly settings: GenerationSettingsReader,
    @Inject(GENERATION_LIMITS) private readonly limits: GenerationLimits,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly transitions: JobTransitions,
    @Optional() @Inject(GENERATION_TELEMETRY) private readonly telemetry?: GenerationTelemetry | null,
    @Optional() @Inject(LIVE_UPDATES) private readonly live?: LiveUpdates | null,
  ) {}

  async run(jobId: string, attemptNo: number, logger: Logger, wait = 0): Promise<RunOutcome> {
    const job = await this.repository.jobById(jobId);
    // A stale delivery: the job moved on (cancelled, another attempt, settled).
    if (!job || job.attemptCount + 1 !== attemptNo || (job.status !== 'queued' && job.status !== 'repairing'))
      return 'skipped';
    const mode = job.status === 'repairing' ? 'repair' : 'create';
    if (job.cancelRequestedAt) {
      if (job.status === 'queued') {
        await this.transitions.move(job.id, 'cancelled', {
          errorCode: 'CANCELLED',
          errorMessage: 'Cancelled by a person',
        });
        await this.transitions.dispatch(job.batchId);
      }
      return 'cancelled';
    }
    const engine = this.engines.get(job.engineCurrent);
    const batch = await this.repository.batchById(job.batchId);
    if (!engine || !batch)
      return this.settle(
        job,
        null,
        { code: 'ENGINE_UNAVAILABLE', message: `No engine ${job.engineCurrent}`, retryable: false },
        logger,
      );
    const allowed = canStart({
      workspace: await this.budget.check(job.organizationId),
      batchBudgetUsd: batch.budgetUsd,
      batchCostUsd: batch.costUsd,
    });
    if (!allowed.ok)
      return this.settle(
        job,
        null,
        { code: allowed.code, message: allowed.reason, retryable: false },
        logger,
      );

    const held = await this.takeSlots(job, engine);
    if (!held) {
      // No slot: tried again a little later, without counting an attempt (the jitter spreads the retries).
      const delayMs = Math.round(this.limits.slotRetryMs * (0.75 + Math.random() * 0.5));
      await this.queues.run(job.engineCurrent, {
        jobId: job.id,
        attemptNo,
        priority: queuePriority(job.priority, job.position),
        delayMs,
        wait: wait + 1,
      });
      this.telemetry?.leaseWait(job.engineCurrent);
      return 'deferred';
    }
    if (job.dispatchedAt)
      this.telemetry?.queueWait(
        job.engineCurrent,
        Math.max(0, this.clock.now().getTime() - job.dispatchedAt.getTime()) / 1000,
      );
    await this.countSandboxes();
    try {
      // One trace per attempt; its phases are child spans of the job's (the attempt id in the attributes).
      return await startSpan(
        'generation.attempt',
        {
          'generation.job_id': job.id,
          'generation.attempt': attemptNo,
          'generation.engine': engine.id,
          'generation.mode': mode,
        },
        () => this.attempt(job, engine, attemptNo, mode, logger, held),
      );
    } finally {
      for (const lease of held) await this.leases.release(lease.key, lease.token).catch(() => undefined);
      await this.countSandboxes();
    }
  }

  private async countSandboxes() {
    if (!this.telemetry) return;
    this.telemetry.sandboxes(await this.leases.held('gen:slots:sandboxes').catch(() => 0));
  }

  /** The workspace's slot for the engine, then a sandbox from the deployment's pool; all or none. */
  private async takeSlots(job: StoredJob, engine: AgentEngine) {
    const settings = await this.settings.resolve(job.organizationId);
    const wanted = [
      {
        key: `gen:slots:${job.organizationId}:${engine.id}`,
        limit: settings.engineConcurrency[engine.id] ?? engine.capabilities.maxParallel,
      },
      ...(engine.capabilities.sandboxed
        ? [{ key: 'gen:slots:sandboxes', limit: this.limits.maxSandboxes }]
        : []),
    ];
    const held: { key: string; token: string }[] = [];
    for (const slot of wanted) {
      const token = await this.leases.acquire(slot.key, slot.limit, LEASE_TTL_MS);
      if (!token) {
        for (const lease of held) await this.leases.release(lease.key, lease.token);
        return null;
      }
      held.push({ key: slot.key, token });
    }
    return held;
  }

  private async attempt(
    job: StoredJob,
    engine: AgentEngine,
    attemptNo: number,
    mode: 'create' | 'repair',
    logger: Logger,
    held: readonly { key: string; token: string }[],
  ): Promise<RunOutcome> {
    const attemptId = newId();
    if (
      !(await this.repository.insertAttempt({
        id: attemptId,
        jobId: job.id,
        attemptNo,
        engine: engine.id,
        mode,
      }))
    )
      return 'skipped';
    await this.repository.updateJob(job.id, {
      attemptCount: attemptNo,
      engineAttempts: job.engineAttempts + 1,
    });
    const previous = mode === 'repair' ? await this.repository.attempt(job.id, attemptNo - 1) : undefined;
    // What the quality gate found on the previous attempt (absent: repair from the spec alone).
    let repairIssues: unknown[] = [];
    if (previous) {
      const report = await this.artifacts
        .get(qualityReportKey(job.organizationId, job.id, previous.attemptNo))
        .catch(() => undefined);
      try {
        const parsed = report ? (JSON.parse(report.toString('utf8')) as { issues?: unknown[] }) : undefined;
        repairIssues = Array.isArray(parsed?.issues) ? parsed.issues : [];
      } catch {
        repairIssues = [];
      }
    }
    const buffer: EngineEvent[] = [];
    const flush = async () => {
      if (buffer.length === 0) return;
      const batch = buffer.splice(0);
      const seqs = await this.repository.appendEvents(job.id, attemptId, batch);
      await this.stream
        .publish(
          job.id,
          batch.map((event, index) => ({ seq: seqs[index] ?? 0, event })),
        )
        .catch(() => undefined);
    };
    const flusher = setInterval(
      () => void flush().catch((error: unknown) => logger.warn({ err: error }, 'event flush failed')),
      FLUSH_MS,
    );
    const heartbeat = setInterval(() => {
      void (async () => {
        await this.repository.heartbeat(attemptId, this.clock.now());
        for (const lease of held) await this.leases.renew(lease.key, lease.token, LEASE_TTL_MS);
      })().catch((error: unknown) => logger.warn({ err: error }, 'heartbeat failed'));
    }, this.limits.heartbeatEveryMs);
    const cancel = this.cancels.watch(job.id);
    const controller = new AbortController();
    const abort = (code: string, message: string) => {
      if (!controller.signal.aborted) controller.abort(new AttemptAborted(code, message));
    };
    cancel.signal.addEventListener('abort', () => abort('CANCELLED', 'Cancelled by a person'), {
      once: true,
    });
    const deadlineAt = new Date(this.clock.now().getTime() + this.limits.attemptTimeoutMs);
    const deadline = setTimeout(
      () => abort('TIMEOUT', 'The attempt ran out of time'),
      this.limits.attemptTimeoutMs,
    );
    let cost = 0;
    let specRef: string | null = null;
    let failure: { code: string; message: string; retryable: boolean } | null = null;
    try {
      if (mode === 'create') await this.transitions.move(job.id, 'preparing');
      buffer.push({ type: 'status', phase: 'preparing' });
      const preparing = this.clock.now().getTime();
      const prepared = await startSpan('generation.prepare', { 'generation.job_id': job.id }, () =>
        this.preparer.prepare(job),
      );
      this.telemetry?.phase(engine.id, 'prepare', (this.clock.now().getTime() - preparing) / 1000);
      await this.repository.insertArtifact({
        jobId: job.id,
        attemptId,
        kind: 'workspace_bundle',
        storageKey: prepared.bundleRef,
        sha256: prepared.bundleHash ?? createHash('sha256').update(prepared.bundleRef).digest('hex'),
        bytes: prepared.bytes ?? 0,
      });
      if (prepared.factSnapshotId || prepared.bundleHash)
        await this.repository.setAttemptWorkspace(attemptId, {
          factSnapshotId: prepared.factSnapshotId ?? null,
          bundleHash: prepared.bundleHash ?? null,
        });
      if (mode === 'create') await this.transitions.move(job.id, 'running');
      const settings = await this.settings.resolve(job.organizationId);
      const running = this.clock.now().getTime();
      const stream = engine.run(
        {
          jobId: job.id,
          attemptNo,
          mode,
          organizationId: job.organizationId,
          workspace: { bundleRef: prepared.bundleRef },
          brief: prepared.summary,
          budgetUsd: job.budgetUsd,
          deadlineAt,
          locales: settings.locales,
          ...(previous?.specRef ? { repair: { baseSpecRef: previous.specRef, issues: repairIssues } } : {}),
          logger,
          writeSpec: async (spec) => {
            const body = Buffer.from(JSON.stringify(spec));
            if (body.length > this.limits.maxSpecBytes)
              throw new AttemptAborted('INVALID_OUTPUT', 'The spec is too large');
            const key = `generation/${job.organizationId}/${job.id}/${attemptNo}/site.json`;
            await this.artifacts.put(key, body, 'application/json');
            await this.repository.insertArtifact({
              jobId: job.id,
              attemptId,
              kind: 'site_spec',
              storageKey: key,
              sha256: createHash('sha256').update(body).digest('hex'),
              bytes: body.length,
            });
            return key;
          },
        },
        controller.signal,
      );
      for await (const raw of stream) {
        if (controller.signal.aborted) break;
        const parsed = EngineEventSchema.safeParse(raw);
        if (!parsed.success) continue;
        const event = parsed.data;
        buffer.push(event);
        if (buffer.length >= FLUSH_EVENTS) await flush();
        if (event.type === 'progress')
          await this.live
            ?.job({
              ...job,
              status: mode === 'repair' ? 'repairing' : 'running',
              costUsd: job.costUsd + cost,
            })
            .catch(() => undefined);
        if (event.type === 'usage') {
          cost += event.costUsd;
          await this.repository.addCost(job.id, job.batchId, attemptId, event.costUsd, {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
          });
          if (overBudget(job.costUsd + cost, job.budgetUsd))
            abort('BUDGET_EXCEEDED', 'The job went over its budget');
        } else if (event.type === 'error') {
          failure = { code: event.code, message: event.message, retryable: event.retryable };
          break;
        } else if (event.type === 'done') {
          specRef = event.siteSpecRef;
          break;
        }
      }
      this.telemetry?.phase(engine.id, 'run', (this.clock.now().getTime() - running) / 1000);
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        failure =
          reason instanceof AttemptAborted
            ? { code: reason.code, message: reason.message, retryable: reason.code === 'TIMEOUT' }
            : { code: 'CANCELLED', message: 'Aborted', retryable: false };
      } else if (!failure && !specRef) {
        failure = { code: 'INVALID_OUTPUT', message: 'The engine ended without a site', retryable: true };
      }
    } catch (error) {
      const reason = controller.signal.reason;
      failure =
        reason instanceof AttemptAborted
          ? { code: reason.code, message: reason.message, retryable: reason.code === 'TIMEOUT' }
          : error instanceof AttemptAborted
            ? { code: error.code, message: error.message, retryable: true }
            : {
                code: 'ENGINE_ERROR',
                message: error instanceof Error ? error.message.slice(0, 500) : 'Engine failed',
                retryable: true,
              };
    } finally {
      clearInterval(flusher);
      clearInterval(heartbeat);
      clearTimeout(deadline);
      cancel.stop();
      await flush().catch((error: unknown) => logger.warn({ err: error }, 'event flush failed'));
    }
    const attempt = await this.repository.attemptById(attemptId);
    if (!failure && specRef && attempt) {
      if (
        !(await this.repository.finishAttempt(attemptId, {
          status: 'succeeded',
          exitReason: 'done',
          specRef,
          finishedAt: this.clock.now(),
        }))
      )
        return 'skipped';
      await this.transitions.move(job.id, 'validating');
      await this.queues.quality({ jobId: job.id, attemptId, organizationId: job.organizationId });
      return 'validating';
    }
    return this.settle(
      job,
      attempt ?? null,
      failure ?? { code: 'ENGINE_ERROR', message: 'Unknown', retryable: true },
      logger,
    );
  }

  /**
   * After a failed attempt (or a job that cannot start): cancelled, retried on the same engine, moved to the next
   * engine of the chain, or failed for good — then the batch's next jobs are released.
   */
  async settle(
    job: StoredJob,
    attempt: StoredAttempt | null,
    failure: { code: string; message: string; retryable: boolean },
    logger: Logger,
  ): Promise<RunOutcome> {
    const cancelled = failure.code === 'CANCELLED';
    if (attempt?.status === 'running') {
      const finished = await this.repository.finishAttempt(attempt.id, {
        status: cancelled ? 'cancelled' : 'failed',
        exitReason: failure.code,
        error: failure,
        finishedAt: this.clock.now(),
      });
      if (!finished) return 'skipped';
    }
    const current = (await this.repository.jobById(job.id)) ?? job;
    if (cancelled) {
      await this.transitions.move(job.id, 'cancelled', {
        errorCode: 'CANCELLED',
        errorMessage: failure.message,
      });
      await this.transitions.dispatch(job.batchId);
      return 'cancelled';
    }
    const attempts = await this.repository.attempts(job.id);
    const settings = await this.settings.resolve(job.organizationId);
    const available = new Set<EngineId>();
    for (const engine of this.engines.list())
      if (settings.allowedEngines.includes(engine.id) && (await engine.available(job.organizationId)))
        available.add(engine.id);
    const decision = decideAfterFailure(failure, {
      engine: current.engineCurrent,
      engineAttempts: current.engineAttempts,
      maxAttemptsPerEngine: current.maxAttemptsPerEngine,
      failoverChain: current.failoverChain,
      available,
      invalidOutputs: attempts.filter((a) => a.exitReason === 'INVALID_OUTPUT').length,
    });
    logger.info({ jobId: job.id, code: failure.code, decision: decision.action }, decision.reason);
    // A job that could not even start (no attempt) goes straight from queued to failed.
    if (current.status !== 'failed')
      await this.transitions.move(job.id, 'failed', {
        errorCode: failure.code,
        errorMessage: failure.message.slice(0, 500),
      });
    if (decision.action === 'fail') {
      await this.transitions.dispatch(job.batchId);
      return 'failed';
    }
    const failover = decision.action === 'failover';
    await this.transitions.move(job.id, 'queued', {
      engineCurrent: decision.engine,
      engineSelectionReason: failover ? decision.reason : current.engineSelectionReason,
      ...(failover
        ? { engineAttempts: 0, failoverChain: current.failoverChain.filter((e) => e !== decision.engine) }
        : {}),
    });
    const updated = (await this.repository.jobById(job.id)) ?? current;
    // Backoff before the next attempt: 2 s, 4 s, 8 s… (at most a minute).
    const delayMs = Math.min(60_000, 2_000 * 2 ** Math.max(0, updated.engineAttempts - 1));
    await this.queues.run(decision.engine, {
      jobId: job.id,
      attemptNo: updated.attemptCount + 1,
      priority: queuePriority(updated.priority, updated.position),
      delayMs,
    });
    return 'retrying';
  }
}
