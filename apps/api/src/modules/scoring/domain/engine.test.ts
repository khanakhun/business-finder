import {
  FEATURE_DEFINITIONS,
  FEATURE_KEYS,
  type FeatureKey,
  type FeatureValue,
  type FeatureVector,
  OFFERS,
  ScoreResultSchema,
  type ScoringProfileConfig,
  type ScoringProfileConfigInput,
  ScoringProfileConfigSchema,
} from '@bf/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { facts } from './__fixtures__/facts.ts';
import { BUILTIN_PROFILES } from './builtin-profiles.ts';
import { scoreBusiness, scoreVector } from './engine.ts';
import { withDefaults } from './features/registry.ts';
import { applyTransform } from './transforms.ts';

// Seeded property runs (testing.md: reproducible); override with FC_SEED to explore.
const SEED = Number(process.env.FC_SEED ?? 20_261_016);

const profile = (
  input: Omit<ScoringProfileConfigInput, 'offer' | 'tiers'> & Partial<ScoringProfileConfigInput>,
) => ScoringProfileConfigSchema.parse({ offer: 'new_website', tiers: { A: 70, B: 40 }, ...input });

/** A value of the feature's type, mostly inside its usual range (where transforms change), or missing. */
const arbitraryValue = (key: FeatureKey): fc.Arbitrary<FeatureValue> => {
  const definition = FEATURE_DEFINITIONS[key];
  const [min, max] = definition.range ?? [0, 100];
  const span = max - min;
  const value: fc.Arbitrary<FeatureValue> =
    definition.type === 'boolean'
      ? fc.boolean()
      : definition.type === 'enum'
        ? fc.constantFrom(...(definition.values ?? []))
        : fc.double({ min: min - span * 0.2, max: max + span * 0.2, noNaN: true, noDefaultInfinity: true });
  return fc.option(value, { nil: null, freq: 5 });
};
const vectors: fc.Arbitrary<FeatureVector> = fc.record(
  Object.fromEntries(FEATURE_KEYS.map((key) => [key, arbitraryValue(key)])) as Record<
    FeatureKey,
    fc.Arbitrary<FeatureValue>
  >,
);
const builtins = fc.constantFrom(...OFFERS.map((offer) => BUILTIN_PROFILES[offer]));

describe('scoring engine properties', () => {
  it('is deterministic and always returns a valid result', () => {
    fc.assert(
      fc.property(vectors, builtins, (vector, config) => {
        const result = scoreVector(config, vector);
        expect(scoreVector(config, structuredClone(vector))).toEqual(result);
        expect(ScoreResultSchema.parse(result)).toEqual(result);
      }),
      { seed: SEED, numRuns: 300 },
    );
    const input = facts();
    for (const offer of OFFERS) {
      expect(scoreBusiness(BUILTIN_PROFILES[offer], structuredClone(input))).toEqual(
        scoreBusiness(BUILTIN_PROFILES[offer], input),
      );
    }
  });

  it('is monotone: a value the transform rates higher never lowers the score (never raises it, if weight < 0)', () => {
    // Without gates (a gate may depend on the changed feature by design).
    const ungated = builtins.map((config) => ({ ...config, gates: [] }) as ScoringProfileConfig);
    const keyed = fc
      .constantFrom(...FEATURE_KEYS)
      .chain((key) => fc.tuple(fc.constant(key), arbitraryValue(key)));
    fc.assert(
      fc.property(vectors, ungated, keyed, (vector, config, [key, other]) => {
        const weight = config.weights[key] ?? 0;
        const rate = (value: FeatureValue) =>
          applyTransform(config.transforms[key], value) ?? config.missing[key] ?? null;
        const from = rate(withDefaults(vector)[key] ?? null);
        const to = rate(withDefaults({ [key]: other })[key] ?? null);
        // From missing to known counts as a raise for a positive weight (missing never helps it).
        fc.pre(
          weight > 0
            ? to !== null && (from === null || to >= from)
            : weight < 0 && to !== null && from !== null && to >= from,
        );
        const base = scoreVector(config, vector).score;
        const changed = scoreVector(config, { ...vector, [key]: other }).score;
        expect(weight > 0 ? changed >= base : changed <= base).toBe(true);
      }),
      { seed: SEED, numRuns: 500 },
    );
  });

  it('always gives X and 0 for do-not-contact, whatever the profile and its gates', () => {
    fc.assert(
      fc.property(vectors, builtins, (vector, config) => {
        expect(scoreVector(config, { ...vector, do_not_contact: true })).toMatchObject({
          score: 0,
          tier: 'X',
          reasons: [],
          gated: { gate: 'do_not_contact', effect: 'exclude' },
        });
      }),
      { seed: SEED, numRuns: 200 },
    );
  });
});

describe('scoring engine', () => {
  it('weighs transformed values; missing features contribute nothing (or the profile value) but still count', () => {
    const config = profile({
      weights: { has_phone: 30, rating_avg: 50, vision_overall: 20, multi_location: -20 },
      transforms: {
        rating_avg: { kind: 'linear', min: 3, max: 5 },
        vision_overall: { kind: 'linear', min: 0, max: 10 },
      },
    });
    const vector = { has_phone: true, rating_avg: 4, vision_overall: null, multi_location: true };
    const result = scoreVector(config, vector);
    // 100 × (30 × 1 + 50 × 0.5 + 0 − 20 × 1) ÷ 100 = 35
    expect(result.score).toBe(35);
    expect(result.contributions).toEqual([
      { feature: 'vision_overall', rawValue: null, transformed: null, weight: 20, contribution: 0 },
      { feature: 'rating_avg', rawValue: 4, transformed: 0.5, weight: 50, contribution: 25 },
      { feature: 'multi_location', rawValue: true, transformed: 1, weight: -20, contribution: -20 },
      { feature: 'has_phone', rawValue: true, transformed: 1, weight: 30, contribution: 30 },
    ]);
    // The profile's missing value stands in: + 20 × 0.9.
    expect(scoreVector({ ...config, missing: { vision_overall: 0.9 } }, vector).score).toBe(53);
    // A registry default stands in first: has_phone missing → false → 0.
    expect(
      scoreVector(config, { rating_avg: 5 }).contributions.find((c) => c.feature === 'has_phone'),
    ).toMatchObject({
      rawValue: false,
      transformed: 0,
    });
    // Negative totals clamp to 0.
    expect(scoreVector(config, { multi_location: true }).score).toBe(0);
  });

  it('treats non-finite numbers as missing', () => {
    const config = profile({
      weights: { rating_avg: 50, lcp_mobile_seconds: 50 },
      transforms: {
        rating_avg: { kind: 'linear', min: 3, max: 5 },
        lcp_mobile_seconds: {
          kind: 'piecewise',
          points: [
            [0, 0],
            [10, 1],
          ],
        },
      },
    });
    const result = scoreVector(config, {
      rating_avg: Number.NaN,
      lcp_mobile_seconds: Number.POSITIVE_INFINITY,
    });
    expect(result).toMatchObject({ score: 0, tier: 'C' });
    expect(result.contributions.map((c) => c.transformed)).toEqual([null, null]);
    expect(ScoreResultSchema.safeParse(result).success).toBe(true);
  });

  it('scores 0 when no weight is positive (a config the schema refuses)', () => {
    const config = { ...profile({ weights: { has_phone: 1 } }), weights: { multi_location: -10 } };
    const result = scoreVector(config as ScoringProfileConfig, { multi_location: true });
    expect(result.score).toBe(0);
    expect(result.contributions.map((c) => c.contribution)).toEqual([0]);
  });

  it('assigns tiers at their thresholds, from the rounded score', () => {
    const config = profile({ weights: { owner_response_rate: 100 }, tiers: { A: 70, B: 40 } });
    const tier = (share: number) => scoreVector(config, { owner_response_rate: share }).tier;
    expect([tier(0.7), tier(0.69), tier(0.4), tier(0.39)]).toEqual(['A', 'B', 'B', 'C']);
    expect([tier(0.695), tier(0.6949)]).toEqual(['A', 'B']);
  });

  describe('gates', () => {
    const gate = (id: string, effect: { type: 'exclude' } | { type: 'cap'; max: number }) => ({
      id,
      when: { feature: 'has_phone' as const, eq: true },
      effect,
      reason: { en: id, fr: id },
    });

    it('excludes (X, 0, no reasons but the gate) and caps; do-not-contact wins over any profile gate', () => {
      const config = profile({
        weights: { has_phone: 100 },
        gates: [gate('capped', { type: 'cap', max: 30 })],
      });
      expect(scoreVector(config, { has_phone: true })).toMatchObject({
        score: 30,
        tier: 'C',
        gated: { gate: 'capped', effect: 'cap' },
      });
      const excluding = profile({
        weights: { has_phone: 100 },
        gates: [gate('closed', { type: 'exclude' })],
      });
      const excluded = scoreVector(excluding, { has_phone: true });
      expect(excluded).toMatchObject({ score: 0, tier: 'X', reasons: [], gated: { gate: 'closed' } });
      // The contributions are kept for the snapshot.
      expect(excluded.contributions[0]?.contribution).toBe(100);
      expect(scoreVector(excluding, { has_phone: true, do_not_contact: true }).gated?.gate).toBe(
        'do_not_contact',
      );
    });

    it('does not report a cap that does not lower the score; a cap at a tier threshold keeps the tier', () => {
      const config = profile({
        weights: { has_phone: 20, has_whatsapp: 80 },
        gates: [gate('loose', { type: 'cap', max: 30 })],
      });
      expect(scoreVector(config, { has_phone: true, has_whatsapp: false })).toMatchObject({
        score: 20,
        gated: null,
      });
      const atA = profile({ weights: { has_phone: 100 }, gates: [gate('at_a', { type: 'cap', max: 70 })] });
      expect(scoreVector(atA, { has_phone: true })).toMatchObject({
        score: 70,
        tier: 'A',
        gated: { gate: 'at_a' },
      });
    });

    it('keeps the first of equal caps, the lowest cap overall', () => {
      const config = profile({
        weights: { has_phone: 100 },
        gates: [
          gate('first', { type: 'cap', max: 20 }),
          gate('second', { type: 'cap', max: 20 }),
          gate('higher', { type: 'cap', max: 50 }),
        ],
      });
      expect(scoreVector(config, { has_phone: true }).gated?.gate).toBe('first');
    });
  });

  describe('reasons', () => {
    it('gives the strongest three each way; zero contributions are never reasons', () => {
      const config = profile({
        weights: {
          has_phone: 10,
          rating_avg: 40,
          'pain_share.booking_friction': 30,
          lcp_mobile_seconds: 20,
          has_whatsapp: 5,
          vision_overall: 15,
          multi_location: -10,
          price_level: -5,
        },
        transforms: {
          rating_avg: { kind: 'linear', min: 3, max: 5 },
          lcp_mobile_seconds: { kind: 'linear', min: 2, max: 8 },
          vision_overall: { kind: 'linear', min: 0, max: 10 },
          price_level: { kind: 'linear', min: 1, max: 4 },
        },
      });
      const { reasons } = scoreVector(config, {
        has_phone: true,
        rating_avg: 4.6,
        'pain_share.booking_friction': 0.35,
        lcp_mobile_seconds: 6.5,
        has_whatsapp: true,
        vision_overall: 0,
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
      // One positive contribution: one reason.
      const single = scoreVector(profile({ weights: { has_phone: 10, has_whatsapp: 10 } }), {
        has_phone: true,
      });
      expect(single.reasons).toHaveLength(1);
    });

    it('breaks ties by registry order, whatever the order of the weights', () => {
      const weights = { has_whatsapp: 10, has_phone: 10, has_website: 10 };
      const { reasons } = scoreVector(profile({ weights }), {
        has_whatsapp: true,
        has_phone: true,
        has_website: true,
      });
      expect(reasons.map((reason) => reason.feature)).toEqual(['has_website', 'has_phone', 'has_whatsapp']);
    });

    it('skips a contribution without any text and fills in with the next one', () => {
      // pipeline_status has texts for disqualified/won/lost only: `new` has none.
      const config = profile({
        weights: { pipeline_status: 50, has_phone: 10, has_whatsapp: 10, has_website: 10, tourism_facing: 5 },
        transforms: { pipeline_status: { kind: 'enumMap', map: { new: 1 }, default: 0 } },
      });
      const { reasons } = scoreVector(config, {
        pipeline_status: 'new',
        has_phone: true,
        has_whatsapp: true,
        has_website: true,
        tourism_facing: true,
      });
      expect(reasons.map((reason) => reason.feature)).toEqual(['has_website', 'has_phone', 'has_whatsapp']);
    });

    it('reads texts by value, by side of the pivot, the profile’s before the registry’s', () => {
      const config = profile({
        weights: { has_booking_tool: 20, website_status: 20, sentiment_avg: 20, has_phone: 20 },
        transforms: {
          has_booking_tool: { kind: 'boolean', true: 0, false: 1 },
          website_status: { kind: 'enumMap', map: { parked: 1 }, default: 0 },
          sentiment_avg: { kind: 'linear', min: -1, max: 1 },
        },
        reasonTemplates: { has_phone: { value: { en: 'Phone: {value}', fr: 'Téléphone : {value}' } } },
      });
      const text = (vector: FeatureVector, feature: FeatureKey) =>
        scoreVector(config, vector).reasons.find((reason) => reason.feature === feature)?.text.en;
      expect(text({ has_booking_tool: false }, 'has_booking_tool')).toBe('No online booking.');
      expect(text({ website_status: 'parked' }, 'website_status')).toBe(
        'The domain is parked: no real site.',
      );
      expect(text({ sentiment_avg: -0.5 }, 'sentiment_avg')).toBe('Customers are unhappy in reviews.');
      expect(text({ sentiment_avg: 0.6 }, 'sentiment_avg')).toBe('Customers are happy in reviews.');
      // The profile's `value` text wins over the registry's `true` text.
      expect(text({ has_phone: true }, 'has_phone')).toBe('Phone: true');
    });
  });

  it('scores a business from its facts, keeping the stored feature snapshot', () => {
    const noSite = facts({ business: { websiteUrl: null }, audit: null, site: null });
    const result = scoreBusiness(BUILTIN_PROFILES.new_website, noSite);
    expect(result.features.website_status).toBe('none');
    expect(result.tier).toBe('A');
    expect(scoreBusiness(BUILTIN_PROFILES.new_website, facts())).toMatchObject({
      gated: { gate: 'has_working_website' },
    });
    // The snapshot keeps missing values missing (defaults are a scoring matter).
    expect(
      scoreBusiness(BUILTIN_PROFILES.new_website, facts({ category: null })).features.tourism_facing,
    ).toBeNull();
  });
});
