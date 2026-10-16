import { GateSchema } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { fromGate, type GateDraft, operatorsFor, type Rule, ruleToLeaf, toGate } from './gates.ts';

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
});
