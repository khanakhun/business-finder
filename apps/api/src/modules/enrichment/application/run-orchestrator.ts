import {
  BudgetExceededError,
  BusinessEnriched,
  type Clock,
  DomainError,
  type EnrichmentSkipReason,
  type EnrichmentStepId,
  ExternalServiceError,
} from '@bf/contracts';
import { type Logger, metrics } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { EventRecorder } from '../../platform/events/event-recorder.ts';
import { LOGGER } from '../../platform/logging/logger.ts';
import { RATE_LIMITER, type RateLimiter } from '../../platform/rate-limit/valkey-rate-limiter.ts';
import { isTransient } from '../../platform/resilience/resilience.ts';
import type { EnrichmentStep, StepOutput, StepResult } from '../domain/enrichment-step.ts';
import { finalStatus, isTerminalRun, isTerminalStep, readiness } from '../domain/run-state.ts';
import {
  ENRICHMENT_QUEUE,
  ENRICHMENT_REPOSITORY,
  type EnrichmentQueue,
  type EnrichmentRepository,
  NO_SOLICITATION_MARKERS,
  type NoSolicitationMarkers,
  RUN_PROGRESS,
  type RunProgress,
  type RunRecord,
  type StepCompletion,
  type StepRecord,
  SUBJECT_READER,
  type SubjectReader,
} from './ports.ts';
import { StepRegistry } from './step-registry.ts';

/** Attempts of a step before it fails (transient errors only; an open circuit or a shutdown does not count). */
export const MAX_STEP_ATTEMPTS = 3;
const HEARTBEAT_MS = 15_000;
const RETRY_BASE_MS = 30_000;
const CIRCUIT_WAIT_MS = 60_000;

const stepRuns = () =>
  metrics.counter({
    name: 'bf_enrichment_steps_total',
    help: 'Enrichment steps finished, by step and outcome',
    labelNames: ['step', 'outcome'],
  });
const stepDurations = () =>
  metrics.histogram({
    name: 'bf_enrichment_step_duration_seconds',
    help: 'Time to execute one enrichment step',
    labelNames: ['step'],
  });

/** A message safe to store and show: domain errors say what happened; anything else stays in the logs. */
const safeMessage = (error: unknown) =>
  (error instanceof DomainError ? error.message : 'Unexpected error').slice(0, 500);

/** Adapters report an open circuit as an external error with this reason (see `site-intel.adapters.ts`). */
const isCircuitOpen = (error: unknown) =>
  error instanceof ExternalServiceError && error.details?.reason === 'circuit_open';

interface Advance {
  readonly run: RunRecord;
  readonly steps: readonly StepRecord[];
  readonly ready: readonly StepRecord[];
  readonly finished: boolean;
}

/**
 * Executes enrichment runs (BF-027, ADR-0006): the run's step rows are the DAG and the source of truth; jobs only
 * move rows. Every state change happens under the run's row lock: completing a step and moving the run forward
 * (skipping blocked steps, picking ready ones, finalizing) is one transaction. `executeStep` is the Template
 * Method around a step plugin — claim (only once its dependencies are terminal), rate limit, heartbeat, execute,
 * meter, record, retry transient failures with backoff.
 */
@Injectable()
export class EnrichmentOrchestrator {
  constructor(
    @Inject(ENRICHMENT_REPOSITORY) private readonly runs: EnrichmentRepository,
    @Inject(ENRICHMENT_QUEUE) private readonly queue: EnrichmentQueue,
    @Inject(SUBJECT_READER) private readonly subjects: SubjectReader,
    @Inject(RUN_PROGRESS) private readonly progress: RunProgress,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(NO_SOLICITATION_MARKERS) private readonly markers: NoSolicitationMarkers,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly registry: StepRegistry,
    private readonly events: EventRecorder,
  ) {}

  /** Starts a queued run (its first steps). Safe to call again. */
  async start(runId: string): Promise<void> {
    const run = await this.runs.findRun(runId);
    if (!run || isTerminalRun(run.status)) return;
    if (run.status === 'queued') await this.runs.markRunning(runId, this.clock.now());
    await this.advance(runId);
  }

  /** Moves a running run forward; enqueues and publishes after the transaction commits. */
  async advance(runId: string): Promise<void> {
    await this.afterCommit(await this.advanceTx(runId));
  }

  @Transactional()
  private async advanceTx(runId: string): Promise<Advance | undefined> {
    const run = await this.runs.lockRun(runId);
    if (run?.status !== 'running') return undefined;
    return this.advanceLocked(run);
  }

  /** Records a step's outcome and moves the run forward, atomically. Not accepted when the step was not running. */
  @Transactional()
  private async completeTx(
    run: RunRecord,
    step: StepRecord,
    completion: StepCompletion,
  ): Promise<{ accepted: boolean; advance: Advance | undefined }> {
    const locked = await this.runs.lockRun(run.id);
    if (locked?.status !== 'running') return { accepted: false, advance: undefined };
    const accepted = await this.runs.completeStep(step.id, completion, this.clock.now());
    if (!accepted) return { accepted, advance: undefined };
    return { accepted, advance: await this.advanceLocked((await this.runs.findRun(run.id)) ?? locked) };
  }

  /** Under the run's row lock: skip what cannot run, pick what can, or finalize. */
  private async advanceLocked(run: RunRecord): Promise<Advance> {
    const now = this.clock.now();
    let steps = await this.runs.steps(run.id);
    // Skips propagate down the DAG (a skipped step can block its own dependents): repeat until stable.
    for (let pass = 0; pass < steps.length; pass++) {
      const blocked = new Map<EnrichmentSkipReason, string[]>();
      for (const step of steps) {
        if (step.status !== 'queued') continue;
        const state = readiness(step, steps);
        if (state.kind === 'skip') blocked.set(state.reason, [...(blocked.get(state.reason) ?? []), step.id]);
      }
      if (blocked.size === 0) break;
      for (const [reason, ids] of blocked) await this.runs.skipSteps(ids, reason, now);
      steps = await this.runs.steps(run.id);
    }
    if (steps.every((step) => isTerminalStep(step.status))) {
      await this.runs.finishRun(run.id, finalStatus(steps), now);
      const finished = (await this.runs.findRun(run.id)) ?? run;
      await this.recordEnriched(finished, steps);
      return { run: finished, steps, ready: [], finished: true };
    }
    // A step waiting out a backoff or a rate limit already has its (delayed) job.
    const ready = steps.filter(
      (step) =>
        step.status === 'queued' &&
        (!step.notBefore || step.notBefore <= now) &&
        readiness(step, steps).kind === 'ready',
    );
    return { run, steps, ready, finished: false };
  }

  /** `business.enriched` when at least one step produced something (a run that only skipped changes nothing). */
  private async recordEnriched(run: RunRecord, steps: readonly StepRecord[]): Promise<void> {
    if (!steps.some((s) => s.status === 'done')) return;
    await this.events.record(BusinessEnriched, {
      orgId: run.organizationId,
      actor: { type: 'job', id: 'enrichment' },
      payload: {
        businessId: run.businessId,
        runId: run.id,
        steps: steps.map((s) => ({ id: s.step, status: s.status })),
        changedFields: [...run.changedFields],
        noSolicitationDetected: await this.markers.active(run.businessId),
      },
    });
  }

  private async afterCommit(outcome: Advance | undefined): Promise<void> {
    if (!outcome) return;
    for (const step of outcome.ready)
      await this.queue.step(step, outcome.run.organizationId, outcome.run.trigger);
    await this.progress.publish(outcome.run, outcome.steps, outcome.finished);
  }

  /**
   * Runs one step of a run (the job handler). Idempotent: a step that is not queued, or whose dependencies are not
   * all terminal yet, is left alone (its job is a duplicate or early).
   */
  async executeStep(runId: string, stepRowId: string, signal: AbortSignal, jobId: string): Promise<void> {
    const queued = await this.runs.findStep(stepRowId);
    const run = await this.runs.findRun(runId);
    if (queued?.status !== 'queued' || run?.status !== 'running') return;
    const plugin = this.registry.get(queued.step);
    if (plugin?.rateLimit) {
      const { key, capacity, perSecond } = plugin.rateLimit;
      const waitMs = await this.limiter.tryTake(`enrichment:${key}`, { capacity, perSecond });
      if (waitMs > 0) {
        // Never hold a worker waiting for a token: come back when one is due (the reconciler waits too).
        const until = new Date(this.clock.now().getTime() + waitMs);
        await this.runs.deferStep(stepRowId, until);
        await this.queue.step(queued, run.organizationId, run.trigger, {
          delayMs: waitMs,
          retryKey: `rl${this.clock.now().getTime()}`,
        });
        return;
      }
    }
    const step = await this.runs.claimStep(stepRowId, this.clock.now(), jobId);
    if (!step) return;
    await this.progress.publish(run, await this.runs.steps(runId), false);
    const completion = plugin
      ? await this.runPlugin(plugin, run, step, signal)
      : ({ status: 'skipped', reason: 'not_registered', costUsd: 0 } as const);
    if (completion === 'released') return;
    const { accepted, advance } = await this.completeTx(run, step, completion);
    if (accepted) stepRuns().inc({ step: step.step, outcome: completion.status });
    await this.afterCommit(advance);
  }

  /** The reconciler gave up on a step whose workers kept dying: it fails, and the run moves on. */
  async failLostStep(run: RunRecord, step: StepRecord): Promise<boolean> {
    const { accepted, advance } = await this.completeTx(run, step, {
      status: 'failed',
      error: 'Worker lost',
      costUsd: 0,
    });
    await this.afterCommit(advance);
    return accepted;
  }

  /** Cancels an open run: queued and running steps are skipped, running jobs are signalled. */
  async cancel(runId: string): Promise<boolean> {
    const result = await this.cancelTx(runId);
    if (!result) return false;
    await this.queue.cancel(result.running);
    await this.progress.publish(result.run, result.steps, true);
    return true;
  }

  @Transactional()
  private async cancelTx(
    runId: string,
  ): Promise<{ run: RunRecord; steps: StepRecord[]; running: StepRecord[] } | undefined> {
    const run = await this.runs.lockRun(runId);
    if (!run || isTerminalRun(run.status)) return undefined;
    const now = this.clock.now();
    const open = (await this.runs.steps(runId)).filter((s) => !isTerminalStep(s.status));
    await this.runs.skipSteps(
      open.map((s) => s.id),
      'cancelled',
      now,
    );
    await this.runs.finishRun(runId, 'cancelled', now);
    const cancelled = (await this.runs.findRun(runId)) ?? run;
    const steps = await this.runs.steps(runId);
    // Steps that finished before the stop still changed the business: scoring must hear about it.
    await this.recordEnriched(cancelled, steps);
    return { run: cancelled, steps, running: open.filter((s) => s.status === 'running') };
  }

  private async runPlugin(
    plugin: EnrichmentStep,
    run: RunRecord,
    step: StepRecord,
    signal: AbortSignal,
  ): Promise<StepCompletion | 'released'> {
    const subject = await this.subjects.subject(run.businessId);
    if (!subject) return { status: 'skipped', reason: 'not_applicable', costUsd: 0 };
    const applies = plugin.appliesTo(subject);
    if (applies !== true) return { status: 'skipped', reason: applies, costUsd: 0 };
    const heartbeat = setInterval(() => {
      this.runs.heartbeat(step.id, this.clock.now()).catch((error: unknown) => {
        this.logger.warn({ err: error, stepId: step.id }, 'enrichment heartbeat failed');
      });
    }, HEARTBEAT_MS);
    heartbeat.unref();
    const timer = stepDurations().startTimer({ step: step.step });
    try {
      const result: StepResult = await plugin.execute({
        runId: run.id,
        stepRowId: step.id,
        organizationId: run.organizationId,
        subject,
        inputHash: step.inputHash ?? plugin.inputHash(subject),
        dependencies: await this.dependencyOutputs(run, plugin.dependsOn),
        signal,
      });
      return result.outcome === 'done'
        ? {
            status: 'done',
            costUsd: result.costUsd,
            outputRef: result.outputRef,
            changedFields: result.changedFields,
          }
        : { status: 'skipped', reason: result.reason, costUsd: result.costUsd };
    } catch (error) {
      return this.onFailure(run, step, error, signal);
    } finally {
      clearInterval(heartbeat);
      timer();
    }
  }

  private async onFailure(
    run: RunRecord,
    step: StepRecord,
    error: unknown,
    signal: AbortSignal,
  ): Promise<StepCompletion | 'released'> {
    const now = this.clock.now();
    if (signal.aborted) {
      // A cancelled run already skipped its steps. Otherwise the worker is stopping (deploy) or lost its lock:
      // give the attempt back and let another worker take the step now.
      const current = await this.runs.findRun(run.id);
      if (current?.status === 'running') {
        const released = await this.runs.releaseStep(step.id, null, now, { refund: true });
        if (released) {
          await this.queue.step(released, run.organizationId, run.trigger, {
            retryKey: `sd${now.getTime()}`,
          });
        }
      }
      return 'released';
    }
    if (error instanceof BudgetExceededError) return { status: 'skipped', reason: 'budget', costUsd: 0 };
    if (isCircuitOpen(error)) {
      // The dependency is down for everyone: wait without using up this step's attempts.
      const until = new Date(now.getTime() + CIRCUIT_WAIT_MS);
      const released = await this.runs.releaseStep(step.id, 'Service unavailable; retrying later', now, {
        refund: true,
        notBefore: until,
      });
      if (released) {
        await this.queue.step(released, run.organizationId, run.trigger, {
          delayMs: CIRCUIT_WAIT_MS,
          retryKey: `cb${now.getTime()}`,
        });
      }
      return 'released';
    }
    if (isTransient(error) && step.attempt < MAX_STEP_ATTEMPTS) {
      this.logger.warn({ err: error, step: step.step, attempt: step.attempt }, 'enrichment step will retry');
      const delayMs = RETRY_BASE_MS * 2 ** (step.attempt - 1);
      const released = await this.runs.releaseStep(step.id, safeMessage(error), now, {
        notBefore: new Date(now.getTime() + delayMs),
      });
      // Keyed by the new attempt number: a job distinct from the one running now.
      if (released) await this.queue.step(released, run.organizationId, run.trigger, { delayMs });
      return 'released';
    }
    this.logger.error({ err: error, step: step.step, runId: run.id }, 'enrichment step failed');
    return { status: 'failed', error: safeMessage(error), costUsd: 0 };
  }

  /** Outputs the step depends on (all terminal by now): the latest ones, from this run or fresh earlier ones. */
  private async dependencyOutputs(
    run: RunRecord,
    dependsOn: readonly EnrichmentStepId[],
  ): Promise<Map<EnrichmentStepId, StepOutput>> {
    if (dependsOn.length === 0) return new Map();
    const latest = await this.runs.latestOutputs(run.businessId);
    return new Map(dependsOn.flatMap((id) => (latest.has(id) ? [[id, latest.get(id) as StepOutput]] : [])));
  }
}
