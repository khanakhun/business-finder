import { DEFAULT_ENRICHMENT_SETTINGS, fixedClock } from '@bf/contracts';
import { createLogger } from '@bf/observability';
import { describe, expect, it, vi } from 'vitest';
import type { EnrichmentStep } from '../domain/enrichment-step.ts';
import { NightlyRefresh } from './enrichment.triggers.ts';
import { NightlyMaintenance, StepRegistry } from './step-registry.ts';

// The nightly job's BF-029 additions: maintenance hooks (each isolated) and steps leaving the refresh per workspace.

const NOW = new Date('2026-10-15T03:00:00.000Z');

const step = (
  id: EnrichmentStep['id'],
  refreshableFor?: EnrichmentStep['refreshableFor'],
): EnrichmentStep => ({
  id,
  dependsOn: [],
  costCategory: 'free',
  ttlDays: 30,
  appliesTo: () => true,
  inputHash: () => id,
  estimateCost: () => 0,
  execute: async () => ({ outcome: 'skipped', reason: 'not_applicable', costUsd: 0 }),
  ...(refreshableFor ? { refreshableFor } : {}),
});

function setup(steps: EnrichmentStep[]) {
  const registry = new StepRegistry();
  for (const s of steps) registry.register(s);
  const maintenance = new NightlyMaintenance();
  const runs = {
    trackingOrganizations: async () => ['org-a', 'org-b'],
    countRunsSince: async () => 0,
    refreshCandidates: vi.fn(async () => [] as string[]),
  };
  const refresh = new NightlyRefresh(
    runs as never,
    fixedClock(NOW),
    createLogger({ service: 'test', level: 'fatal' }),
    { execute: vi.fn() } as never,
    { enrichmentSettings: async () => DEFAULT_ENRICHMENT_SETTINGS } as never,
    registry,
    { purgeExpired: async () => 0 } as never,
    maintenance,
  );
  return { refresh, runs, maintenance };
}

describe('NightlyMaintenance', () => {
  it('refuses a task name twice', () => {
    const maintenance = new NightlyMaintenance();
    maintenance.register('x', async () => 0);
    expect(() => maintenance.register('x', async () => 0)).toThrow(/already registered/);
  });
});

describe('NightlyRefresh', () => {
  it('runs every maintenance task with the night’s time, even when one fails', async () => {
    const { refresh, maintenance } = setup([step('site_intel')]);
    const count = vi.fn(async () => 3);
    maintenance.register('boom', async () => {
      throw new Error('boom');
    });
    maintenance.register('count', count);
    await expect(refresh.run('2026-10-15')).resolves.toEqual({ started: 0 });
    expect(count).toHaveBeenCalledWith(NOW);
  });

  it('leaves out, per workspace, the steps that could only skip there', async () => {
    const { refresh, runs } = setup([
      step('site_intel'),
      step('reviews', async (organizationId) => organizationId === 'org-b'),
    ]);
    await refresh.run('2026-10-15');
    const stepsFor = (org: string) =>
      (runs.refreshCandidates.mock.calls as unknown as Array<[string, Array<{ step: string }>]>)
        .filter(([organizationId]) => organizationId === org)
        .flatMap(([, steps]) => steps.map((s) => s.step));
    expect(stepsFor('org-a')).toEqual(['site_intel']);
    expect(stepsFor('org-b')).toEqual(['site_intel', 'reviews']);
  });

  it('skips a workspace for which no step is refreshable', async () => {
    const { refresh, runs } = setup([step('reviews', async () => false)]);
    await refresh.run('2026-10-15');
    expect(runs.refreshCandidates).not.toHaveBeenCalled();
  });
});
