import { type EngineCapabilities, GENERATION_JOB_STATUSES, type GenerationJobStatus } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { batchStatus, countStatuses, priorityFor, queuePriority } from './batch.ts';
import { canStart, cheaperEngine, jobBudget, MAX_JOB_BUDGET_USD, overBudget } from './budget-policy.ts';
import { type EngineCandidate, estimatedWaitSec, selectEngine } from './engine-selection-policy.ts';
import { chainAfter, decideAfterFailure } from './failover-policy.ts';
import { assertTransition, canTransition, isActive, isCancellable } from './job-state-machine.ts';

const ALLOWED: Record<GenerationJobStatus, GenerationJobStatus[]> = {
  queued: ['preparing', 'cancelled', 'failed'],
  preparing: ['running', 'failed', 'cancelled'],
  running: ['validating', 'failed', 'cancelled'],
  validating: ['repairing', 'succeeded', 'needs_review', 'failed'],
  repairing: ['validating', 'failed', 'cancelled'],
  failed: ['queued'],
  cancelled: ['queued'],
  needs_review: ['queued'],
  succeeded: [],
};

describe('job state machine (DOMAIN §3.3)', () => {
  for (const from of GENERATION_JOB_STATUSES)
    for (const to of GENERATION_JOB_STATUSES)
      it(`${ALLOWED[from].includes(to) ? 'allows' : 'refuses'} ${from} → ${to}`, () => {
        expect(canTransition(from, to)).toBe(ALLOWED[from].includes(to));
        if (ALLOWED[from].includes(to)) expect(() => assertTransition(from, to)).not.toThrow();
        else expect(() => assertTransition(from, to)).toThrow(/cannot go from/);
      });

  it('tells active and cancellable states apart', () => {
    expect(isActive('repairing')).toBe(true);
    expect(isActive('needs_review')).toBe(false);
    expect(isCancellable('validating')).toBe(false);
    expect(isCancellable('running')).toBe(true);
  });
});

describe('failover policy', () => {
  const job = {
    engine: 'claude-code' as const,
    engineAttempts: 1,
    maxAttemptsPerEngine: 2,
    failoverChain: ['claude-code', 'codex', 'blocks'] as const,
    available: new Set(['claude-code', 'codex', 'blocks'] as const),
    invalidOutputs: 0,
  };

  it('retries a retryable failure on the same engine, then fails over along the chain', () => {
    expect(decideAfterFailure({ code: 'TIMEOUT', retryable: true }, job)).toMatchObject({
      action: 'retry',
      engine: 'claude-code',
    });
    expect(
      decideAfterFailure({ code: 'TIMEOUT', retryable: true }, { ...job, engineAttempts: 2 }),
    ).toMatchObject({
      action: 'failover',
      engine: 'codex',
    });
    // An unavailable next engine is skipped.
    expect(
      decideAfterFailure(
        { code: 'SANDBOX_CRASHED', retryable: true },
        { ...job, engineAttempts: 2, available: new Set(['claude-code', 'blocks'] as const) },
      ),
    ).toMatchObject({ action: 'failover', engine: 'blocks' });
    expect(
      decideAfterFailure(
        { code: 'TIMEOUT', retryable: true },
        { ...job, engineAttempts: 2, failoverChain: [] },
      ),
    ).toMatchObject({ action: 'fail', code: 'TIMEOUT' });
  });

  it('stops at once on a fatal failure, and retries an invalid output once only', () => {
    for (const code of ['BUDGET_EXCEEDED', 'POLICY_VIOLATION', 'INVALID_BRIEF', 'CANCELLED'])
      expect(decideAfterFailure({ code, retryable: true }, job)).toMatchObject({ action: 'fail', code });
    expect(decideAfterFailure({ code: 'WEIRD', retryable: false }, job).action).toBe('fail');
    expect(decideAfterFailure({ code: 'WEIRD', retryable: true }, job).action).toBe('retry');
    expect(
      decideAfterFailure({ code: 'INVALID_OUTPUT', retryable: true }, { ...job, invalidOutputs: 2 }),
    ).toMatchObject({
      action: 'failover',
    });
    expect(
      decideAfterFailure({ code: 'ENGINE_INVALID_OUTPUT', retryable: true }, { ...job, invalidOutputs: 1 }),
    ).toMatchObject({ action: 'retry' });
    expect(
      decideAfterFailure({ code: 'ENGINE_INVALID_OUTPUT', retryable: true }, { ...job, invalidOutputs: 2 }),
    ).toMatchObject({ action: 'failover', engine: 'codex' });
    expect(chainAfter(['a', 'b', 'c'] as never, 'b' as never)).toEqual(['c']);
    expect(chainAfter(['a'] as never, 'z' as never)).toEqual(['a']);
  });
});

describe('failover policy for coding agents (BF-044)', () => {
  const job = {
    engine: 'claude-code' as const,
    engineAttempts: 1,
    maxAttemptsPerEngine: 3,
    failoverChain: ['claude-code', 'codex', 'blocks'] as const,
    available: new Set(['claude-code', 'codex', 'blocks'] as const),
    invalidOutputs: 0,
  };

  it('moves an engine-fatal failure to the next engine without retrying, even when marked not retryable', () => {
    for (const code of ['ENGINE_BUDGET_EXCEEDED', 'ENGINE_VERSION_UNSUPPORTED'])
      for (const retryable of [true, false])
        expect(decideAfterFailure({ code, retryable }, job)).toMatchObject({
          action: 'failover',
          engine: 'codex',
        });
    expect(
      decideAfterFailure({ code: 'ENGINE_BUDGET_EXCEEDED', retryable: false }, { ...job, failoverChain: [] }),
    ).toMatchObject({ action: 'fail', code: 'ENGINE_BUDGET_EXCEEDED' });
  });

  it('retries an incomplete run on the same engine', () => {
    expect(decideAfterFailure({ code: 'ENGINE_INCOMPLETE', retryable: true }, job)).toMatchObject({
      action: 'retry',
      engine: 'claude-code',
    });
  });
});

const caps = (overrides: Partial<EngineCapabilities> = {}): EngineCapabilities => ({
  sandboxed: true,
  supportsRepair: true,
  supportsChatEdit: false,
  maxParallel: 2,
  typicalCostUsd: 1.5,
  typicalDurationSec: 600,
  ...overrides,
});
const candidate = (id: EngineCandidate['id'], overrides: Partial<EngineCandidate> = {}): EngineCandidate => ({
  id,
  available: true,
  capabilities: caps(
    id === 'blocks' ? { sandboxed: false, typicalCostUsd: 0.2, typicalDurationSec: 60, maxParallel: 4 } : {},
  ),
  backlog: 0,
  running: 0,
  ...overrides,
});

describe('auto engine selection', () => {
  const all = [candidate('blocks'), candidate('claude-code'), candidate('codex')];
  const allowed = ['blocks', 'claude-code', 'codex'] as const;

  it('sends simple sites to blocks and larger ones to the agent with the shortest wait, explaining why', () => {
    const simple = selectEngine({
      allowed,
      candidates: all,
      complexity: { pages: 3, items: 8, locales: 2 },
      budgetUsd: 5,
    });
    expect(simple.engine).toBe('blocks');
    expect(simple.reason).toMatch(/simple site/);
    const busy = [
      candidate('blocks'),
      candidate('claude-code', { backlog: 6 }),
      candidate('codex', { backlog: 1 }),
    ];
    const large = selectEngine({
      allowed,
      candidates: busy,
      complexity: { pages: 7, items: 30, locales: 3 },
      budgetUsd: 5,
    });
    expect(large.engine).toBe('codex');
    expect(large.reason).toMatch(/shortest wait/);
  });

  it('respects the allowed engines, availability and the budget', () => {
    const complex = { pages: 7, items: 30, locales: 3 };
    expect(
      selectEngine({ allowed: ['codex'], candidates: all, complexity: complex, budgetUsd: 5 }).engine,
    ).toBe('codex');
    expect(
      selectEngine({
        allowed,
        candidates: [candidate('codex', { available: false })],
        complexity: complex,
        budgetUsd: 5,
      }).engine,
    ).toBeNull();
    // Only blocks fits a small budget, even for a large site.
    expect(selectEngine({ allowed, candidates: all, complexity: complex, budgetUsd: 0.5 }).engine).toBe(
      'blocks',
    );
    expect(selectEngine({ allowed, candidates: all, complexity: complex, budgetUsd: 0.1 }).engine).toBeNull();
    expect(estimatedWaitSec(candidate('codex', { backlog: 4 }))).toBe(1200);
  });
});

describe('budgets and batches', () => {
  it('bounds job budgets and refuses work past the workspace or batch budget', () => {
    expect(jobBudget(undefined, 3)).toBe(3);
    expect(jobBudget(500, 3)).toBe(MAX_JOB_BUDGET_USD);
    expect(jobBudget(undefined, undefined)).toBe(2);
    expect(canStart({ workspace: 'hard', batchBudgetUsd: null, batchCostUsd: 0 })).toMatchObject({
      ok: false,
    });
    expect(canStart({ workspace: 'soft', batchBudgetUsd: 10, batchCostUsd: 10 })).toMatchObject({
      ok: false,
    });
    expect(canStart({ workspace: 'soft', batchBudgetUsd: 10, batchCostUsd: 9 })).toEqual({ ok: true });
    expect(overBudget(2.01, 2)).toBe(true);
    expect(
      cheaperEngine(
        [
          { id: 'codex', typicalCostUsd: 1.5 },
          { id: 'blocks', typicalCostUsd: 0.2 },
        ],
        1,
      ),
    ).toBe('blocks');
  });

  it('derives the batch status and orders priorities by position', () => {
    expect(batchStatus({})).toBe('queued');
    expect(batchStatus(countStatuses(['queued', 'queued']))).toBe('queued');
    expect(batchStatus(countStatuses(['queued', 'running']))).toBe('running');
    expect(batchStatus(countStatuses(['succeeded', 'succeeded']))).toBe('completed');
    expect(batchStatus(countStatuses(['succeeded', 'needs_review']))).toBe('completed_with_issues');
    expect(batchStatus(countStatuses(['cancelled', 'cancelled']))).toBe('cancelled');
    expect([0, 1, 2].map((p) => priorityFor(p, 3))).toEqual([1, 6, 10]);
    expect(priorityFor(2, 3, 4)).toBe(4);
    expect(priorityFor(0, 1)).toBe(1);
    expect(queuePriority(1, 0)).toBeLessThan(queuePriority(1, 1));
    expect(queuePriority(1, 99)).toBeLessThan(queuePriority(2, 0));
  });
});
