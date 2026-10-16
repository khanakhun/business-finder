import { type Gate, GateSchema, ScoringProfileConfigSchema } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { fromGate, type GateDraft, operatorsFor, type Rule, ruleToLeaf, toGate } from './gates.ts';
import { nextGateId } from './gates-builder.tsx';

const reason = { en: 'Closed', fr: 'Fermé' };
const draft = (rules: readonly Rule[], match: 'all' | 'any' = 'all'): GateDraft => ({
  id: 'closed',
  effect: { type: 'exclude' },
  reason,
  mode: 'rules',
  match,
  rules,
});

describe('gates builder', () => {
  it('produces a valid gate: one rule as a leaf, several as all/any', () => {
    const one = toGate(draft([{ feature: 'operating_status', op: 'eq', value: 'closed_permanently' }]));
    expect(one?.when).toEqual({ feature: 'operating_status', eq: 'closed_permanently' });
    const many = toGate(
      draft(
        [
          { feature: 'rating_avg', op: 'lt', value: '3,5' },
          { feature: 'has_website', op: 'eq', value: 'false' },
          { feature: 'operating_status', op: 'in', value: 'closed_permanently, closed_temporarily' },
        ],
        'any',
      ),
    );
    expect(many?.when).toEqual({
      any: [
        { feature: 'rating_avg', lt: 3.5 },
        { feature: 'has_website', eq: false },
        { feature: 'operating_status', in: ['closed_permanently', 'closed_temporarily'] },
      ],
    });
    expect(GateSchema.safeParse(many).success).toBe(true);
  });

  it('refuses values that do not fit the feature', () => {
    expect(ruleToLeaf({ feature: 'rating_avg', op: 'gt', value: 'high' })).toBeNull();
    expect(ruleToLeaf({ feature: 'has_website', op: 'eq', value: 'maybe' })).toBeNull();
    expect(ruleToLeaf({ feature: 'operating_status', op: 'eq', value: 'gone' })).toBeNull();
    expect(ruleToLeaf({ feature: 'operating_status', op: 'in', value: ' , ' })).toBeNull();
    expect(toGate(draft([]))).toBeNull();
    expect(toGate(draft([{ feature: 'rating_avg', op: 'gt', value: '' }]))).toBeNull();
  });

  it('offers operators by type, and no "is missing" for a feature with a default', () => {
    expect(operatorsFor('rating_avg')).toContain('gte');
    expect(operatorsFor('operating_status')).toContain('in');
    expect(operatorsFor('has_website')).not.toContain('gt');
  });

  it('reads stored gates back into rules, and keeps other shapes as they are', () => {
    const stored = toGate(
      draft([
        { feature: 'rating_avg', op: 'gte', value: '4' },
        { feature: 'operating_status', op: 'neq', value: 'operational' },
      ]),
    );
    if (!stored) throw new Error('no gate');
    expect(toGate(fromGate(stored))).toEqual(stored);
    const nested = { ...stored, when: { not: { feature: 'has_website', eq: true } } } as const;
    const kept = fromGate(nested);
    expect(kept.mode).toBe('advanced');
    expect(toGate(kept)).toEqual(nested);
  });

  it.each([
    [
      'three conditions, all',
      {
        all: [
          { feature: 'has_website', eq: false },
          { feature: 'rating_avg', lt: 3.5 },
          { feature: 'operating_status', neq: 'operational' },
        ],
      },
    ],
    ['any of a list', { feature: 'operating_status', in: ['closed_permanently', 'closed_temporarily'] }],
    ['unknown value', { feature: 'sentiment_avg', isNull: true }],
    ['a decimal bound', { feature: 'rating_avg', lt: 0.25 }],
    [
      'all with a not (read-only)',
      { all: [{ feature: 'has_website', eq: true }, { not: { feature: 'has_phone', eq: true } }] },
    ],
  ] as const)('keeps a gate (%s) unchanged and valid in a full profile', (_case, when) => {
    const gate = { id: 'shape', effect: { type: 'cap', max: 40 }, reason, when } as unknown as Gate;
    expect(toGate(fromGate(gate))).toEqual(gate);
    const config = {
      offer: 'new_website',
      weights: { has_phone: 10 },
      tiers: { A: 60, B: 30 },
      gates: [gate],
    };
    expect(ScoringProfileConfigSchema.safeParse(config).success).toBe(true);
  });

  it('saves a single-condition group as that condition (the same rule)', () => {
    const gate = {
      id: 'one',
      effect: { type: 'exclude' },
      reason,
      when: { any: [{ feature: 'has_phone', eq: false }] },
    } as unknown as Gate;
    expect(toGate(fromGate(gate))?.when).toEqual({ feature: 'has_phone', eq: false });
  });
});

describe('nextGateId', () => {
  it('takes the first free gate_<n>', () => {
    const named = (...ids: string[]) => ids.map((id) => ({ ...draft([]), id }));
    expect(nextGateId([])).toBe('gate_1');
    expect(nextGateId(named('gate_2'))).toBe('gate_1');
    expect(nextGateId(named('gate_1', 'gate_2'))).toBe('gate_3');
  });
});
