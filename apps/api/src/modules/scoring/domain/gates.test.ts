import type { FeatureVector, Gate } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { decidingGate, matches } from './gates.ts';

const vector: FeatureVector = {
  operating_status: 'operational',
  rating_avg: 4.2,
  has_phone: true,
  has_whatsapp: false,
  price_level: null,
};

const gate = (id: string, when: Gate['when'], effect: Gate['effect']): Gate => ({
  id,
  when,
  effect,
  reason: { en: id, fr: id },
});

describe('gate conditions', () => {
  it('evaluates each operator, and a missing value matches only isNull', () => {
    expect(matches({ feature: 'operating_status', eq: 'operational' }, vector)).toBe(true);
    expect(matches({ feature: 'operating_status', neq: 'operational' }, vector)).toBe(false);
    expect(matches({ feature: 'operating_status', in: ['closed_permanently', 'operational'] }, vector)).toBe(
      true,
    );
    expect(matches({ feature: 'rating_avg', gt: 4.2 }, vector)).toBe(false);
    expect(matches({ feature: 'rating_avg', gte: 4.2 }, vector)).toBe(true);
    expect(matches({ feature: 'rating_avg', lt: 4.5 }, vector)).toBe(true);
    expect(matches({ feature: 'rating_avg', lte: 4 }, vector)).toBe(false);
    expect(matches({ feature: 'price_level', isNull: true }, vector)).toBe(true);
    expect(matches({ feature: 'price_level', isNull: false }, vector)).toBe(false);
    expect(matches({ feature: 'price_level', lt: 5 }, vector)).toBe(false);
    expect(matches({ feature: 'price_level', neq: 2 }, vector)).toBe(false);
    // An absent key is missing too; a comparison on a non-number never matches.
    expect(matches({ feature: 'vision_overall', isNull: true }, vector)).toBe(true);
    expect(matches({ feature: 'operating_status', gt: 1 }, vector)).toBe(false);
  });

  it('combines conditions with all, any and not', () => {
    const reachable = {
      any: [
        { feature: 'has_phone', eq: true },
        { feature: 'has_whatsapp', eq: true },
      ],
    } as const;
    expect(matches(reachable, vector)).toBe(true);
    expect(matches({ all: [reachable, { feature: 'rating_avg', gte: 4.5 }] }, vector)).toBe(false);
    expect(matches({ not: { all: [reachable, { feature: 'rating_avg', gte: 4.5 }] } }, vector)).toBe(true);
  });
});

describe('deciding gate', () => {
  it('lets an exclusion win over caps, the lowest cap win among caps, then profile order', () => {
    const always = { feature: 'has_phone', eq: true } as const;
    const never = { feature: 'has_phone', eq: false } as const;
    expect(decidingGate([gate('cap50', always, { type: 'cap', max: 50 })], vector)?.id).toBe('cap50');
    expect(
      decidingGate(
        [gate('cap50', always, { type: 'cap', max: 50 }), gate('cap20', always, { type: 'cap', max: 20 })],
        vector,
      )?.id,
    ).toBe('cap20');
    expect(
      decidingGate(
        [
          gate('cap20', always, { type: 'cap', max: 20 }),
          gate('first20', always, { type: 'cap', max: 20 }),
          gate('out', always, { type: 'exclude' }),
          gate('later', always, { type: 'exclude' }),
        ],
        vector,
      )?.id,
    ).toBe('out');
    expect(decidingGate([gate('no', never, { type: 'exclude' })], vector)).toBeNull();
  });
});
