import { fixedClock, type ScoringProfileConfig } from '@bf/contracts';
import { describe, expect, it, vi } from 'vitest';
import { facts as aBusiness } from '../domain/__fixtures__/facts.ts';
import { scoreBusiness } from '../domain/engine.ts';
import type { FactsAssembler, ScoringRepository } from './ports.ts';
import { ScoringEditorQueries } from './profile-management.use-cases.ts';

const ORG = '01990000-0000-7000-8000-0000000000a1';
const A = '01990000-0000-7000-8000-0000000000c1';
const B = '01990000-0000-7000-8000-0000000000c2';

const config = {
  kind: 'rules',
  offer: 'new_website',
  weights: { has_phone: 20, has_website: -10 },
  transforms: {},
  missing: {},
  gates: [
    {
      id: 'no_phone',
      when: { feature: 'has_phone', eq: false },
      effect: { type: 'exclude' },
      reason: { en: 'No phone', fr: 'Pas de téléphone' },
    },
  ],
  tiers: { A: 60, B: 30 },
  normalization: 'weighted_sum',
  reasonTemplates: {},
} as ScoringProfileConfig;

const facts = (businessId: string, hasPhone: boolean) =>
  aBusiness({ businessId, contacts: { phones: hasPhone ? 1 : 0 } });

describe('ScoringEditorQueries.explainBatch', () => {
  it('assembles the facts once per business at the injected time, and scores them with the engine', async () => {
    const clock = fixedClock('2026-10-15T12:00:00.000Z');
    const assemble = vi.fn(async () => [facts(A, true), facts(B, false)]);
    const queries = new ScoringEditorQueries(
      {} as ScoringRepository,
      { assemble } as unknown as FactsAssembler,
      clock,
    );
    const { items } = await queries.explainBatch(ORG, { config, businessIds: [A, B, A] });
    expect(assemble).toHaveBeenCalledWith(ORG, [A, B], clock.now());
    const expected = scoreBusiness(config, facts(A, true));
    expect(items[0]).toEqual({ businessId: A, score: expected.score, tier: expected.tier, gate: null });
    // The gate that applied is named.
    expect(items[1]).toMatchObject({ businessId: B, score: 0, tier: 'X', gate: 'no_phone' });
  });
});
