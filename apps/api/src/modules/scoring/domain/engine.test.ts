import {
  FEATURE_DEFINITIONS,
  FEATURE_KEYS,
  type FeatureKey,
  type FeatureValue,
  type FeatureVector,
  OFFERS,
  type ScoringProfileConfig,
  ScoringProfileConfigSchema,
} from '@bf/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { facts } from './__fixtures__/facts.ts';
import { BUILTIN_PROFILES } from './builtin-profiles.ts';
import { scoreBusiness, scoreVector } from './engine.ts';
import { formatValue } from './reasons.ts';

const profile = (input: Partial<ScoringProfileConfig> & Pick<ScoringProfileConfig, 'weights'>) =>
  ScoringProfileConfigSchema.parse({ offer: 'new_website', tiers: { A: 70, B: 40 }, ...input });

/** A random value of the feature's type (or missing). */
const arbitraryValue = (key: FeatureKey): fc.Arbitrary<FeatureValue> => {
  const definition = FEATURE_DEFINITIONS[key];
  const value: fc.Arbitrary<FeatureValue> =
    definition.type === 'boolean'
      ? fc.boolean()
      : definition.type === 'enum'
        ? fc.constantFrom(...(definition.values ?? []))
        : fc.double({ min: -10, max: 2_000, noNaN: true, noDefaultInfinity: true });
  return fc.option(value, { nil: null });
};
const vectors: fc.Arbitrary<FeatureVector> = fc.record(
  Object.fromEntries(FEATURE_KEYS.map((key) => [key, arbitraryValue(key)])) as Record<
    FeatureKey,
    fc.Arbitrary<FeatureValue>
  >,
);

describe('scoring engine', () => {
  it('is deterministic: the same vector and profile give the same result, whatever the key order', () => {
    fc.assert(
      fc.property(vectors, fc.constantFrom(...OFFERS), (vector, offer) => {
        const config = BUILTIN_PROFILES[offer];
        const reversed = Object.fromEntries(Object.entries(vector).reverse()) as FeatureVector;
        const result = scoreVector(config, vector);
        expect(scoreVector(config, reversed)).toEqual(result);
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
        expect(Number.isInteger(result.score)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('is monotone: raising a positively weighted feature (monotone transform) never lowers the score', () => {
    // Without gates (a gate may depend on the raised feature by design).
    const ungated = OFFERS.map((offer) => ({ ...BUILTIN_PROFILES[offer], gates: [] }));
    fc.assert(
      fc.property(
        vectors,
        fc.constantFrom(...ungated),
        fc.double({ min: 0, max: 500, noNaN: true }),
        (vector, config, delta) => {
          const base = scoreVector(config, vector).score;
          for (const [key, weight] of Object.entries(config.weights) as [FeatureKey, number][]) {
            const transform = config.transforms[key];
            const value = vector[key];
            if (weight <= 0 || typeof value !== 'number') continue;
            // Better = larger, except for `inverse` (better = smaller).
            const raised = transform?.kind === 'inverse' ? value - delta : value + delta;
            expect(scoreVector(config, { ...vector, [key]: raised }).score, key).toBeGreaterThanOrEqual(base);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('weighs transformed values; missing features contribute nothing but still count', () => {
    const config = profile({
      weights: { has_phone: 30, rating_avg: 50, has_whatsapp: 20, multi_location: -20 },
      transforms: { rating_avg: { kind: 'linear', min: 3, max: 5 } },
    });
    const result = scoreVector(config, {
      has_phone: true,
      rating_avg: 4,
      has_whatsapp: null,
      multi_location: true,
    });
    // 100 × (30 × 1 + 50 × 0.5 + 0 − 20 × 1) ÷ 100 = 35
    expect(result.score).toBe(35);
    expect(result.tier).toBe('C');
    expect(result.contributions).toEqual([
      { feature: 'rating_avg', rawValue: 4, transformed: 0.5, weight: 50, contribution: 25 },
      { feature: 'multi_location', rawValue: true, transformed: 1, weight: -20, contribution: -20 },
      { feature: 'has_phone', rawValue: true, transformed: 1, weight: 30, contribution: 30 },
      { feature: 'has_whatsapp', rawValue: null, transformed: null, weight: 20, contribution: 0 },
    ]);
    // Negative totals clamp to 0.
    expect(scoreVector(config, { multi_location: true }).score).toBe(0);
  });

  it('assigns tiers at their thresholds', () => {
    const config = profile({ weights: { owner_response_rate: 100 }, tiers: { A: 70, B: 40 } });
    const tier = (share: number) => scoreVector(config, { owner_response_rate: share }).tier;
    expect([tier(0.7), tier(0.69), tier(0.4), tier(0.39)]).toEqual(['A', 'B', 'B', 'C']);
  });

  it('lets gates override: exclusion → X and 0, caps lower the score, do-not-contact always X', () => {
    const config = profile({
      weights: { has_phone: 100 },
      gates: [
        {
          id: 'closed',
          when: { feature: 'operating_status', eq: 'closed_permanently' },
          effect: { type: 'exclude' },
          reason: { en: 'Closed.', fr: 'Fermée.' },
        },
        {
          id: 'lost',
          when: { feature: 'pipeline_status', eq: 'lost' },
          effect: { type: 'cap', max: 30 },
          reason: { en: 'Lost.', fr: 'Perdue.' },
        },
      ],
    });
    expect(scoreVector(config, { has_phone: true })).toMatchObject({ score: 100, tier: 'A', gated: null });
    expect(scoreVector(config, { has_phone: true, pipeline_status: 'lost' })).toMatchObject({
      score: 30,
      tier: 'C',
      gated: { gate: 'lost', effect: 'cap' },
    });
    expect(
      scoreVector(config, {
        has_phone: true,
        pipeline_status: 'lost',
        operating_status: 'closed_permanently',
      }),
    ).toMatchObject({
      score: 0,
      tier: 'X',
      gated: { gate: 'closed', effect: 'exclude', reason: { en: 'Closed.' } },
    });
    // Not a profile's choice: do-not-contact excludes even with no gates.
    expect(scoreVector({ ...config, gates: [] }, { has_phone: true, do_not_contact: true })).toMatchObject({
      score: 0,
      tier: 'X',
      gated: { gate: 'do_not_contact' },
    });
  });

  it('explains the strongest three contributions each way, in English and French', () => {
    const config = profile({
      weights: {
        has_phone: 10,
        rating_avg: 40,
        'pain_share.booking_friction': 30,
        lcp_mobile_seconds: 20,
        has_whatsapp: 5,
        multi_location: -10,
        price_level: -5,
      },
      transforms: {
        rating_avg: { kind: 'linear', min: 3, max: 5 },
        lcp_mobile_seconds: { kind: 'linear', min: 2, max: 8 },
        price_level: { kind: 'linear', min: 1, max: 4 },
      },
      reasonTemplates: { has_phone: { true: { en: 'Pick up the phone!', fr: 'Décrochez !' } } },
    });
    const { reasons } = scoreVector(config, {
      has_phone: true,
      rating_avg: 4.6,
      'pain_share.booking_friction': 0.35,
      lcp_mobile_seconds: 6.5,
      has_whatsapp: true,
      multi_location: true,
      price_level: 3,
    });
    expect(reasons.map((reason) => [reason.feature, reason.direction])).toEqual([
      ['rating_avg', 'positive'],
      ['lcp_mobile_seconds', 'positive'],
      ['pain_share.booking_friction', 'positive'],
      ['multi_location', 'negative'],
      ['price_level', 'negative'],
    ]);
    expect(reasons.find((r) => r.feature === 'pain_share.booking_friction')?.text).toEqual({
      en: '35% of reviews mention booking friction.',
      fr: '35 % des avis évoquent des difficultés de réservation.',
    });
    expect(reasons.find((r) => r.feature === 'lcp_mobile_seconds')?.text.fr).toBe(
      'La page met 6,5 s à s’afficher sur mobile.',
    );
    // The profile's own template wins (has_phone is fourth here, so check it alone).
    const phone = scoreVector(
      profile({ weights: { has_phone: 10 }, reasonTemplates: config.reasonTemplates }),
      {
        has_phone: true,
      },
    );
    expect(phone.reasons[0]?.text).toEqual({ en: 'Pick up the phone!', fr: 'Décrochez !' });
  });

  it('formats values in their unit', () => {
    expect(formatValue('score100', 42, 'en')).toBe('42/100');
    expect(formatValue('score10', 6.5, 'fr')).toBe('6,5/10');
    expect(formatValue('rating', 4.25, 'en')).toBe('4.3/5');
    expect(formatValue('years', 1, 'en')).toBe('1 year');
    expect(formatValue('years', 3.5, 'fr')).toBe('3,5 ans');
    expect(formatValue('days', 12, 'fr')).toBe('12 jours');
    expect(formatValue('none', 'weak', 'en')).toBe('weak');
  });

  it('scores a business from its facts, keeping the feature snapshot', () => {
    const result = scoreBusiness(
      BUILTIN_PROFILES.new_website,
      facts({ business: { websiteUrl: null }, audit: null, site: null }),
    );
    expect(result.features.website_status).toBe('none');
    expect(result.tier).toBe('A');
    expect(scoreBusiness(BUILTIN_PROFILES.new_website, facts())).toMatchObject({
      gated: { gate: 'has_working_website' },
    });
  });
});
