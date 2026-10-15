import { BudgetExceededError, ExternalServiceError, fixedClock, ValidationError } from '@bf/contracts';
import type { DbClient } from '@bf/db';
import { createLogger } from '@bf/observability';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setTransactionalDb } from '../../platform/db/transactional.ts';
import type { EventRecorder } from '../../platform/events/event-recorder.ts';
import type { RateLimiter } from '../../platform/rate-limit/valkey-rate-limiter.ts';
import { type EnrichmentStep, StepDeferredError } from '../domain/enrichment-step.ts';
import type {
  EnrichmentQueue,
  EnrichmentRepository,
  NoSolicitationMarkers,
  RunProgress,
  RunRecord,
  StepRecord,
  SubjectReader,
} from './ports.ts';
import { EnrichmentOrchestrator, MAX_STEP_ATTEMPTS } from './run-orchestrator.ts';
import { StepRegistry } from './step-registry.ts';

const NOW = new Date('2026-10-15T12:00:00.000Z');

const run: RunRecord = {
  id: 'run-1',
  businessId: 'biz-1',
  organizationId: 'org-1',
  requestedBy: null,
  trigger: 'manual',
  requestedSteps: ['psi'],
  force: false,
  status: 'running',
  estimatedUsd: 0,
  costUsd: 0,
  changedFields: [],
  error: null,
  createdAt: NOW,
  startedAt: NOW,
  finishedAt: null,
};

const queued = (attempt = 0): StepRecord => ({
  id: 'step-1',
  runId: 'run-1',
  businessId: 'biz-1',
  step: 'psi',
  dependsOn: [],
  status: 'queued',
  attempt,
  inputHash: 'h',
  outputRef: null,
  estimatedUsd: 0,
  costUsd: 0,
  skipReason: null,
  error: null,
  heartbeatAt: null,
  notBefore: null,
  jobId: null,
  startedAt: null,
  finishedAt: null,
  updatedAt: NOW,
});

// `@Transactional()` needs a client: one whose transaction just runs the callback (the repository is a fake).
beforeAll(() =>
  setTransactionalDb({ transaction: (fn: (tx: unknown) => unknown) => fn({}) } as unknown as DbClient),
);
afterAll(() => setTransactionalDb(undefined));

function harness(execute: EnrichmentStep['execute'], options: { attempt?: number; waitMs?: number } = {}) {
  const attempt = options.attempt ?? 0;
  let status: StepRecord['status'] = 'queued';
  const runs = {
    findStep: vi.fn(async () => queued(attempt)),
    findRun: vi.fn(async () => run),
    lockRun: vi.fn(async () => run),
    steps: vi.fn(async () => [{ ...queued(attempt), status }]),
    claimStep: vi.fn(async () => {
      status = 'running';
      return { ...queued(attempt + 1), status: 'running' as const, jobId: 'job-1' };
    }),
    deferStep: vi.fn(async () => undefined),
    releaseStep: vi.fn(
      async (_id: string, _error: string | null, _at: Date, o?: { refund?: boolean; notBefore?: Date }) => {
        status = 'queued';
        return { ...queued(o?.refund ? attempt : attempt + 1), notBefore: o?.notBefore ?? null };
      },
    ),
    completeStep: vi.fn(async (_id: string, completion: { status: StepRecord['status'] }) => {
      status = completion.status;
      return true;
    }),
    finishRun: vi.fn(async () => true),
    skipSteps: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => undefined),
    latestOutputs: vi.fn(async () => new Map()),
  } as unknown as EnrichmentRepository & Record<string, ReturnType<typeof vi.fn>>;
  const queue = { step: vi.fn(async () => undefined) } as unknown as EnrichmentQueue & {
    step: ReturnType<typeof vi.fn>;
  };
  const registry = new StepRegistry();
  registry.register({
    id: 'psi',
    dependsOn: [],
    costCategory: 'provider',
    ttlDays: 30,
    ...(options.waitMs !== undefined ? { rateLimit: { key: 'psi', capacity: 1, perSecond: 1 } } : {}),
    appliesTo: () => true,
    inputHash: () => 'h',
    estimateCost: () => 0,
    execute,
  });
  const limiter = { tryTake: vi.fn(async () => options.waitMs ?? 0) } as unknown as RateLimiter;
  const subjects = {
    subject: async () => ({
      businessId: 'biz-1',
      displayName: 'Salon',
      websiteUrl: 'https://salon.example.com/',
      countryCode: 'BL',
      locales: ['fr'],
      emails: [],
    }),
    tracks: async () => true,
    trackedSubjects: async () => [],
  } satisfies SubjectReader;
  const events = { record: vi.fn() };
  const orchestrator = new EnrichmentOrchestrator(
    runs,
    queue,
    subjects,
    { publish: async () => undefined } satisfies RunProgress,
    limiter,
    { active: async () => false } as unknown as NoSolicitationMarkers,
    fixedClock(NOW),
    createLogger({ service: 'test', level: 'fatal' }),
    registry,
    events as unknown as EventRecorder,
  );
  return { orchestrator, runs, queue, events };
}

const signal = new AbortController().signal;
const transient = () =>
  new ExternalServiceError('intel', 'Intel returned 503', { details: { retryable: true } });

describe('EnrichmentOrchestrator.executeStep', () => {
  it('records a done step with the claiming job, then finishes the run with business.enriched', async () => {
    const { orchestrator, runs, events } = harness(async () => ({
      outcome: 'done',
      costUsd: 0.01,
      outputRef: { id: 'x' },
      changedFields: ['primaryPhone'],
    }));
    await orchestrator.executeStep('run-1', 'step-1', signal, 'job-1');
    expect(runs.claimStep).toHaveBeenCalledWith('step-1', NOW, 'job-1');
    expect(runs.completeStep).toHaveBeenCalledWith(
      'step-1',
      { status: 'done', costUsd: 0.01, outputRef: { id: 'x' }, changedFields: ['primaryPhone'] },
      NOW,
    );
    // Same transaction: the run is locked, the step completed and the run finished.
    expect(runs.lockRun).toHaveBeenCalled();
    expect(runs.finishRun).toHaveBeenCalledWith('run-1', 'completed', NOW);
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'business.enriched' }),
      expect.objectContaining({
        payload: expect.objectContaining({ businessId: 'biz-1', noSolicitationDetected: false }),
      }),
    );
  });

  it('retries a transient failure later, as a new attempt, after its backoff', async () => {
    const { orchestrator, runs, queue } = harness(async () => {
      throw transient();
    });
    await orchestrator.executeStep('run-1', 'step-1', signal, 'job-1');
    expect(runs.releaseStep).toHaveBeenCalledWith('step-1', 'intel: Intel returned 503', NOW, {
      notBefore: new Date(NOW.getTime() + 30_000),
    });
    expect(runs.completeStep).not.toHaveBeenCalled();
    expect(queue.step).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1 }), 'org-1', 'manual', {
      delayMs: 30_000,
    });
  });

  it('treats an intel timeout as transient (not as a cancellation)', async () => {
    const { orchestrator, runs } = harness(async () => {
      throw new ExternalServiceError('intel', 'Website analysis timed out', {
        details: { reason: 'timeout', retryable: true },
      });
    });
    await orchestrator.executeStep('run-1', 'step-1', signal, 'job-1');
    expect(runs.releaseStep).toHaveBeenCalledWith('step-1', 'intel: Website analysis timed out', NOW, {
      notBefore: expect.any(Date),
    });
  });

  it('fails after the last attempt, and at once on a permanent error', async () => {
    const last = harness(
      async () => {
        throw transient();
      },
      { attempt: MAX_STEP_ATTEMPTS - 1 },
    );
    await last.orchestrator.executeStep('run-1', 'step-1', signal, 'job-1');
    expect(last.runs.completeStep).toHaveBeenCalledWith(
      'step-1',
      { status: 'failed', error: 'intel: Intel returned 503', costUsd: 0 },
      NOW,
    );
    const permanent = harness(async () => {
      throw new ValidationError('Not a website.');
    });
    await permanent.orchestrator.executeStep('run-1', 'step-1', signal, 'job-1');
    expect(permanent.runs.completeStep).toHaveBeenCalledWith(
      'step-1',
      { status: 'failed', error: 'Not a website.', costUsd: 0 },
      NOW,
    );
    expect(permanent.runs.finishRun).toHaveBeenCalledWith('run-1', 'failed', NOW);
  });

  it('waits out an open circuit without using an attempt', async () => {
    const { orchestrator, runs, queue } = harness(async () => {
      throw new ExternalServiceError('intel', 'Website analysis is unavailable', {
        details: { reason: 'circuit_open', retryable: true },
      });
    });
    await orchestrator.executeStep('run-1', 'step-1', signal, 'job-1');
    expect(runs.releaseStep).toHaveBeenCalledWith('step-1', expect.any(String), NOW, {
      refund: true,
      notBefore: new Date(NOW.getTime() + 60_000),
    });
    expect(queue.step).toHaveBeenCalledWith(expect.objectContaining({ attempt: 0 }), 'org-1', 'manual', {
      delayMs: 60_000,
      retryKey: `cb${NOW.getTime()}`,
    });
  });

  it('requeues a step that defers itself, without an attempt, booking what it spent and changed', async () => {
    const { orchestrator, runs, queue } = harness(async () => {
      throw new StepDeferredError(9_000, 0.016, ['contacts']);
    });
    await orchestrator.executeStep('run-1', 'step-1', signal, 'job-1');
    expect(runs.releaseStep).toHaveBeenCalledWith('step-1', null, NOW, {
      refund: true,
      notBefore: new Date(NOW.getTime() + 9_000),
      costUsd: 0.016,
      changedFields: ['contacts'],
    });
    expect(queue.step).toHaveBeenCalledWith(expect.objectContaining({ attempt: 0 }), 'org-1', 'manual', {
      delayMs: 9_000,
      retryKey: `df${NOW.getTime()}`,
    });
    // Bounded: never sooner than a second, never later than ten minutes.
    const late = harness(async () => {
      throw new StepDeferredError(3_600_000, 0);
    });
    await late.orchestrator.executeStep('run-1', 'step-1', signal, 'job-1');
    expect(late.queue.step).toHaveBeenCalledWith(expect.anything(), 'org-1', 'manual', {
      delayMs: 600_000,
      retryKey: `df${NOW.getTime()}`,
    });
  });

  it('gives the attempt back when the worker stops mid-step, and hands the step on', async () => {
    const controller = new AbortController();
    const { orchestrator, runs, queue } = harness(async () => {
      controller.abort(new Error('worker shutting down'));
      throw new Error('aborted');
    });
    await orchestrator.executeStep('run-1', 'step-1', controller.signal, 'job-1');
    expect(runs.releaseStep).toHaveBeenCalledWith('step-1', null, NOW, { refund: true });
    expect(queue.step).toHaveBeenCalledWith(expect.anything(), 'org-1', 'manual', {
      retryKey: `sd${NOW.getTime()}`,
    });
    expect(runs.completeStep).not.toHaveBeenCalled();
  });

  it('skips a step that ran out of AI budget', async () => {
    const { orchestrator, runs } = harness(async () => {
      throw new BudgetExceededError('The workspace AI budget is exhausted.');
    });
    await orchestrator.executeStep('run-1', 'step-1', signal, 'job-1');
    expect(runs.completeStep).toHaveBeenCalledWith(
      'step-1',
      { status: 'skipped', reason: 'budget', costUsd: 0 },
      NOW,
    );
  });

  it('comes back later instead of waiting for a rate-limit token', async () => {
    const execute = vi.fn();
    const { orchestrator, runs, queue } = harness(execute, { waitMs: 1_500 });
    await orchestrator.executeStep('run-1', 'step-1', signal, 'job-1');
    expect(execute).not.toHaveBeenCalled();
    expect(runs.claimStep).not.toHaveBeenCalled();
    expect(runs.deferStep).toHaveBeenCalledWith('step-1', new Date(NOW.getTime() + 1_500));
    expect(queue.step).toHaveBeenCalledWith(expect.objectContaining({ id: 'step-1' }), 'org-1', 'manual', {
      delayMs: 1_500,
      retryKey: `rl${NOW.getTime()}`,
    });
  });

  it('never stores the message of an unexpected error', async () => {
    const last = harness(
      async () => {
        throw new TypeError('secret detail at /internal/path');
      },
      { attempt: MAX_STEP_ATTEMPTS - 1 },
    );
    await last.orchestrator.executeStep('run-1', 'step-1', signal, 'job-1');
    expect(last.runs.completeStep).toHaveBeenCalledWith(
      'step-1',
      { status: 'failed', error: 'Unexpected error', costUsd: 0 },
      NOW,
    );
  });

  it('leaves a step alone when it is not queued, or cannot be claimed yet (a dependency still runs)', async () => {
    const execute = vi.fn();
    const done = harness(execute);
    vi.mocked(done.runs.findStep).mockResolvedValueOnce({ ...queued(), status: 'done' });
    await done.orchestrator.executeStep('run-1', 'step-1', signal, 'job-1');
    expect(done.runs.claimStep).not.toHaveBeenCalled();
    const early = harness(execute);
    vi.mocked(early.runs.claimStep).mockResolvedValueOnce(undefined);
    await early.orchestrator.executeStep('run-1', 'step-1', signal, 'job-2');
    expect(execute).not.toHaveBeenCalled();
  });
});
