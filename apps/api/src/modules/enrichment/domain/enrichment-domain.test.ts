import type { EnrichmentSkipReason, EnrichmentStepId } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import type { EnrichmentStep, EnrichmentSubject, StepOutput } from './enrichment-step.ts';
import { isFresh, planRun, resolveOrder } from './planner.ts';
import { assertRunTransition, finalStatus, readiness, type StepState } from './run-state.ts';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const DAY = 24 * 3_600_000;

const subject = (overrides: Partial<EnrichmentSubject> = {}): EnrichmentSubject => ({
  businessId: '00000000-0000-7000-8000-000000000001',
  displayName: 'Salon Ondine',
  websiteUrl: 'https://salon.example.com/',
  countryCode: 'BL',
  locales: ['fr'],
  emails: [],
  ...overrides,
});

function step(
  id: EnrichmentStepId,
  options: {
    dependsOn?: EnrichmentStepId[];
    cost?: number;
    applies?: true | EnrichmentSkipReason;
    ttlDays?: number;
    isStale?: EnrichmentStep['isStale'];
  } = {},
): EnrichmentStep {
  return {
    id,
    dependsOn: options.dependsOn ?? [],
    costCategory: options.cost ? 'provider' : 'free',
    ttlDays: options.ttlDays ?? 30,
    appliesTo: () => options.applies ?? true,
    inputHash: (s) => `${id}:${s.websiteUrl ?? ''}`,
    estimateCost: () => options.cost ?? 0,
    ...(options.isStale ? { isStale: options.isStale } : {}),
    execute: async () => ({ outcome: 'done', costUsd: 0, outputRef: {}, changedFields: [] }),
  };
}

const registry = (...steps: EnrichmentStep[]) => new Map(steps.map((s) => [s.id, s]));
const output = (id: EnrichmentStepId, ageDays: number, hashOf = subject()): StepOutput => ({
  finishedAt: new Date(NOW.getTime() - ageDays * DAY),
  inputHash: `${id}:${hashOf.websiteUrl ?? ''}`,
  outputRef: {},
});

describe('resolveOrder', () => {
  it('adds dependencies before what needs them, in catalogue order', () => {
    const steps = registry(
      step('site_intel'),
      step('psi', { dependsOn: ['site_intel'] }),
      step('vision_audit', { dependsOn: ['site_intel', 'psi'] }),
    );
    expect(resolveOrder(['vision_audit'], steps)).toEqual(['site_intel', 'psi', 'vision_audit']);
    expect(resolveOrder(['psi', 'site_intel'], steps)).toEqual(['site_intel', 'psi']);
  });

  it('refuses a dependency cycle', () => {
    const steps = registry(step('psi', { dependsOn: ['reviews'] }), step('reviews', { dependsOn: ['psi'] }));
    expect(() => resolveOrder(['psi'], steps)).toThrow(/cycle: psi → reviews → psi/);
  });
});

describe('planRun', () => {
  const base = {
    subject: subject(),
    last: new Map<EnrichmentStepId, StepOutput>(),
    force: false,
    now: NOW,
    remainingUsd: null,
  };

  it('queues every registered step by default and skips unregistered ones on request', () => {
    const steps = registry(
      step('site_intel'),
      step('vision_audit', { dependsOn: ['site_intel'], cost: 0.02 }),
    );
    const plan = planRun({ ...base, steps });
    expect(plan.steps.map((s) => [s.step, s.status])).toEqual([
      ['site_intel', 'queued'],
      ['vision_audit', 'queued'],
    ]);
    expect(plan.estimatedUsd).toBeCloseTo(0.02);
    const asked = planRun({ ...base, steps, requested: ['reviews'] });
    expect(asked.steps).toEqual([
      expect.objectContaining({ step: 'reviews', status: 'skipped', skipReason: 'not_registered' }),
    ]);
  });

  it('skips fresh steps unless forced, and re-runs dependents of a step that runs again', () => {
    const steps = registry(step('site_intel'), step('psi', { dependsOn: ['site_intel'] }));
    const last = new Map<EnrichmentStepId, StepOutput>([
      ['site_intel', output('site_intel', 3)],
      ['psi', output('psi', 3)],
    ]);
    const fresh = planRun({ ...base, steps, last });
    expect(fresh.steps.map((s) => s.skipReason)).toEqual(['fresh', 'fresh']);
    const forced = planRun({ ...base, steps, last, force: true });
    expect(forced.steps.map((s) => s.status)).toEqual(['queued', 'queued']);
    // site_intel is stale (40 days): it runs, so psi (fresh by TTL) runs after it.
    const staleSite = new Map(last).set('site_intel', output('site_intel', 40));
    expect(planRun({ ...base, steps, last: staleSite }).steps.map((s) => s.status)).toEqual([
      'queued',
      'queued',
    ]);
  });

  it('treats a changed input as stale', () => {
    const steps = registry(step('site_intel'));
    const last = new Map<EnrichmentStepId, StepOutput>([
      ['site_intel', output('site_intel', 1, subject({ websiteUrl: 'https://old.example' }))],
    ]);
    expect(planRun({ ...base, steps, last }).steps[0]?.status).toBe('queued');
  });

  it('skips what does not apply and what depends on it', () => {
    const steps = registry(
      step('site_intel', { applies: 'no_website' }),
      step('vision_audit', { dependsOn: ['site_intel'] }),
      step('reviews'),
    );
    const plan = planRun({ ...base, steps });
    expect(plan.steps.map((s) => [s.step, s.skipReason])).toEqual([
      ['site_intel', 'no_website'],
      ['reviews', null],
      ['vision_audit', 'dependency_skipped'],
    ]);
  });

  it('never skips a step for an optional dependency that does not run', () => {
    const verify: EnrichmentStep = {
      ...step('email_verify', { dependsOn: ['site_intel'] }),
      optionalDependencies: ['site_intel'],
    };
    const plan = planRun({ ...base, steps: registry(step('site_intel', { applies: 'no_website' }), verify) });
    expect(plan.steps.map((s) => [s.step, s.status, s.skipReason])).toEqual([
      ['site_intel', 'skipped', 'no_website'],
      ['email_verify', 'queued', null],
    ]);
  });

  it('keeps within the remaining monthly budget, cheapest dependencies first', () => {
    const steps = registry(
      step('site_intel', { cost: 0.01 }),
      step('psi', { dependsOn: ['site_intel'], cost: 0.01 }),
      step('vision_audit', { dependsOn: ['site_intel'], cost: 0.05 }),
    );
    const plan = planRun({ ...base, steps, remainingUsd: 0.03 });
    expect(plan.steps.map((s) => [s.step, s.status, s.skipReason])).toEqual([
      ['site_intel', 'queued', null],
      ['psi', 'queued', null],
      ['vision_audit', 'skipped', 'budget'],
    ]);
    expect(plan.estimatedUsd).toBeCloseTo(0.02);
    // Free steps run on an exhausted budget.
    const free = planRun({ ...base, steps: registry(step('site_intel')), remainingUsd: 0 });
    expect(free.steps[0]?.status).toBe('queued');
  });
});

describe('isFresh', () => {
  it('uses the TTL, or the step rule when it has one', () => {
    const last = output('site_intel', 10);
    expect(isFresh({ ttlDays: 30 }, last, last.inputHash ?? '', NOW)).toBe(true);
    expect(isFresh({ ttlDays: 7 }, last, last.inputHash ?? '', NOW)).toBe(false);
    expect(isFresh({ ttlDays: 30 }, undefined, 'x', NOW)).toBe(false);
    expect(isFresh({ ttlDays: 30, isStale: () => true }, last, last.inputHash ?? '', NOW)).toBe(false);
  });
});

describe('run state', () => {
  const state = (s: Partial<StepState> & Pick<StepState, 'step'>): StepState => ({
    id: s.step,
    dependsOn: [],
    status: 'queued',
    skipReason: null,
    ...s,
  });

  it('readies a step once its dependencies are terminal', () => {
    const site = state({ step: 'site_intel', status: 'running' });
    const psi = state({ step: 'psi', dependsOn: ['site_intel'] });
    expect(readiness(psi, [site, psi])).toEqual({ kind: 'waiting' });
    expect(readiness(psi, [{ ...site, status: 'done' }, psi])).toEqual({ kind: 'ready' });
    expect(readiness(psi, [{ ...site, status: 'skipped', skipReason: 'fresh' }, psi])).toEqual({
      kind: 'ready',
    });
    expect(readiness(psi, [{ ...site, status: 'failed' }, psi])).toEqual({
      kind: 'skip',
      reason: 'dependency_failed',
    });
    expect(readiness(psi, [{ ...site, status: 'skipped', skipReason: 'no_website' }, psi])).toEqual({
      kind: 'skip',
      reason: 'dependency_skipped',
    });
    // Not part of the run (fresh before it): does not block.
    expect(readiness(psi, [psi])).toEqual({ kind: 'ready' });
    // An optional dependency only orders the step: it waits for it, whatever its outcome.
    const optional = new Set(['site_intel'] as const);
    expect(readiness(psi, [site, psi], optional)).toEqual({ kind: 'waiting' });
    for (const outcome of [
      { status: 'failed' as const, skipReason: null },
      { status: 'skipped' as const, skipReason: 'no_website' as const },
    ]) {
      expect(readiness(psi, [{ ...site, ...outcome }, psi], optional)).toEqual({ kind: 'ready' });
    }
  });

  it('ends a run from its step outcomes', () => {
    expect(finalStatus([{ status: 'done' }, { status: 'skipped' }])).toBe('completed');
    expect(finalStatus([{ status: 'skipped' }])).toBe('completed');
    expect(finalStatus([{ status: 'done' }, { status: 'failed' }])).toBe('partially_completed');
    expect(finalStatus([{ status: 'failed' }, { status: 'skipped' }])).toBe('failed');
  });

  it('allows only lifecycle transitions', () => {
    expect(() => assertRunTransition('queued', 'running')).not.toThrow();
    expect(() => assertRunTransition('completed', 'running')).toThrow();
  });
});
