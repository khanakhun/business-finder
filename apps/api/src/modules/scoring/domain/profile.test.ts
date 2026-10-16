import { OFFERS, ScoringProfileConfigSchema } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PROFILES } from './builtin-profiles.ts';
import { validateProfile } from './profile.ts';

describe('profile validation', () => {
  it('accepts every built-in profile', () => {
    for (const offer of OFFERS) {
      expect(BUILTIN_PROFILES[offer].offer).toBe(offer);
      expect(validateProfile(BUILTIN_PROFILES[offer]), offer).toEqual([]);
    }
  });

  it('reports transforms that do not fit, missing transforms, unknown values and duplicate gates', () => {
    const config = ScoringProfileConfigSchema.parse({
      offer: 'local_seo',
      weights: {
        has_phone: 10,
        website_status: 10,
        rating_avg: 10,
        owner_response_rate: 5,
        operating_status: 5,
      },
      transforms: {
        has_phone: { kind: 'linear', min: 0, max: 1 },
        operating_status: { kind: 'enumMap', map: { open: 1 }, default: 0 },
        price_level: { kind: 'linear', min: 1, max: 4 },
      },
      gates: [
        {
          id: 'dup',
          when: { feature: 'website_status', eq: 'gone' },
          effect: { type: 'exclude' },
          reason: { en: 'x', fr: 'x' },
        },
        {
          id: 'dup',
          when: { not: { feature: 'has_phone', gt: 1 } },
          effect: { type: 'cap', max: 5 },
          reason: { en: 'x', fr: 'x' },
        },
      ],
      tiers: { A: 60, B: 30 },
    });
    expect(validateProfile(config).map((problem) => problem.path)).toEqual([
      'transforms.has_phone',
      'transforms.website_status',
      'transforms.rating_avg',
      'transforms.operating_status.map.open',
      'transforms.price_level',
      'gates[0].when',
      'gates[1].id',
      'gates[1].when.not',
    ]);
  });

  it('rejects malformed configs at the schema', () => {
    const base = { offer: 'new_website', weights: { has_phone: 10 }, tiers: { A: 60, B: 30 } };
    expect(ScoringProfileConfigSchema.safeParse(base).success).toBe(true);
    expect(ScoringProfileConfigSchema.safeParse({ ...base, weights: { has_phone: -5 } }).success).toBe(false);
    expect(ScoringProfileConfigSchema.safeParse({ ...base, weights: { nope: 5 } }).success).toBe(false);
    expect(ScoringProfileConfigSchema.safeParse({ ...base, tiers: { A: 30, B: 30 } }).success).toBe(false);
    expect(
      ScoringProfileConfigSchema.safeParse({
        ...base,
        transforms: { has_phone: { kind: 'linear', min: 5, max: 5 } },
      }).success,
    ).toBe(false);
    expect(
      ScoringProfileConfigSchema.safeParse({
        ...base,
        transforms: {
          price_level: {
            kind: 'piecewise',
            points: [
              [2, 0],
              [1, 1],
            ],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      ScoringProfileConfigSchema.safeParse({
        ...base,
        gates: [
          {
            id: 'dup',
            when: { feature: 'has_phone', eq: true, neq: false },
            effect: { type: 'exclude' },
            reason: { en: 'x', fr: 'x' },
          },
        ],
      }).success,
    ).toBe(false);
  });
});
