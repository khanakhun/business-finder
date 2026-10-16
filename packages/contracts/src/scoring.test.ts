import { describe, expect, it } from 'vitest';
import { PAIN_SIGNAL_TAGS } from './reviews.ts';
import {
  FEATURE_DEFINITIONS,
  FEATURE_KEYS,
  FeatureVectorSchema,
  GateConditionSchema,
  profileProblems,
  SCORED_PAIN_TAGS,
  ScoreResultSchema,
  ScoringProfileConfigSchema,
} from './scoring.ts';

/** Every key ever released (append-only: a stored snapshot or profile version may name any of them). */
const RELEASED_KEYS = [
  'has_website',
  'website_status',
  'website_quality_score',
  'psi_mobile_performance',
  'lcp_mobile_seconds',
  'vision_overall',
  'has_https',
  'site_freshness_years',
  'has_booking_tool',
  'has_online_menu',
  'has_contact_form',
  'has_language_gap_for_market',
  'no_solicitation_notice',
  'category_offer_relevance',
  'appointment_based',
  'tourism_facing',
  'price_level',
  'rating_avg',
  'review_count_log',
  'owner_response_rate',
  'multi_location',
  'ad_pixels_present',
  'operating_status',
  'pain_share.booking_friction',
  'pain_share.unreachable_by_phone',
  'pain_share.slow_or_no_reply',
  'pain_share.website_broken_or_outdated',
  'pain_share.no_online_menu_or_prices',
  'pain_share.hard_to_find_info',
  'pain_share.language_barrier',
  'pain_share.payment_friction',
  'pain_share.long_wait_times',
  'pain_share.inconsistent_hours',
  'pain_share.poor_communication',
  'pain_share.positive_strong_reputation',
  'sentiment_avg',
  'has_verified_email',
  'has_usable_email',
  'has_generic_email_only',
  'has_phone',
  'has_whatsapp',
  'do_not_contact',
  'pipeline_status',
  'days_since_last_contact',
];

const config = (input: Record<string, unknown>) =>
  ({
    offer: 'local_seo',
    tiers: { A: 60, B: 30 },
    transforms: {},
    missing: {},
    gates: [],
    reasonTemplates: {},
    kind: 'rules',
    normalization: 'weighted_sum',
    ...input,
  }) as unknown as Parameters<typeof profileProblems>[0];

describe('scoring contracts', () => {
  it('never drops or renames a released feature key', () => {
    expect(FEATURE_KEYS).toEqual(expect.arrayContaining(RELEASED_KEYS));
    expect(FEATURE_KEYS.length).toBe(RELEASED_KEYS.length);
  });

  it('gives defaults, ranges and pivots that fit each feature', () => {
    for (const key of FEATURE_KEYS) {
      const { missingDefault, range, pivot, type, values } = FEATURE_DEFINITIONS[key];
      const fits =
        missingDefault === undefined ||
        (type === 'enum' ? (values ?? []).includes(String(missingDefault)) : typeof missingDefault === type);
      expect(fits, key).toBe(true);
      expect(range === undefined || (type === 'number' && range[0] < range[1]), key).toBe(true);
      expect(pivot === undefined || type === 'number', key).toBe(true);
    }
  });

  it('defines one pain feature per scored pain tag, and EN/FR texts for every feature', () => {
    expect(SCORED_PAIN_TAGS).toEqual(PAIN_SIGNAL_TAGS.filter((tag) => tag !== 'other'));
    for (const tag of SCORED_PAIN_TAGS) expect(FEATURE_KEYS).toContain(`pain_share.${tag}`);
    for (const key of FEATURE_KEYS) {
      const { description, reasons, type, values } = FEATURE_DEFINITIONS[key];
      expect(description.en && description.fr, key).toBeTruthy();
      for (const [value, text] of Object.entries(reasons)) {
        expect(text?.en && text.fr, `${key}.${value}`).toBeTruthy();
        const allowed = [
          'value',
          'missing',
          ...(type === 'boolean' ? ['true', 'false'] : []),
          ...(type === 'enum' ? (values ?? []) : []),
          ...(FEATURE_DEFINITIONS[key].pivot !== undefined ? ['below', 'above'] : []),
        ];
        expect(allowed, `${key}.${value}`).toContain(value);
      }
    }
  });

  it('validates vectors, nested gate conditions and score results', () => {
    expect(
      FeatureVectorSchema.safeParse({ has_phone: true, rating_avg: 4.5, website_status: 'weak' }).success,
    ).toBe(true);
    expect(FeatureVectorSchema.safeParse({ unknown_feature: 1 }).success).toBe(false);
    expect(
      GateConditionSchema.safeParse({
        all: [{ feature: 'has_phone', eq: false }, { not: { any: [{ feature: 'rating_avg', gte: 4 }] } }],
      }).success,
    ).toBe(true);
    expect(GateConditionSchema.safeParse({ feature: 'has_phone' }).success).toBe(false);
    expect(GateConditionSchema.safeParse({ feature: 'has_phone', eq: true, extra: 1 }).success).toBe(false);
    expect(
      ScoreResultSchema.safeParse({ score: 101, tier: 'A', contributions: [], reasons: [], gated: null })
        .success,
    ).toBe(false);
  });
});

describe('profile problems', () => {
  it('reports transforms that do not fit, missing transforms, unknown values, reserved and duplicate gates', () => {
    const problems = profileProblems(
      config({
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
        missing: { vision_overall: 1 },
        reasonTemplates: { has_phone: { yes: { en: 'x', fr: 'x' } } },
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
          {
            id: 'do_not_contact',
            when: { any: [{ feature: 'rating_avg', eq: 'high' }] },
            effect: { type: 'exclude' },
            reason: { en: 'x', fr: 'x' },
          },
          {
            id: 'never',
            when: { feature: 'has_phone', isNull: true },
            effect: { type: 'exclude' },
            reason: { en: 'x', fr: 'x' },
          },
        ],
      }),
    );
    expect(problems.map((problem) => problem.path.join('.'))).toEqual([
      'transforms.has_phone',
      'transforms.website_status',
      'transforms.rating_avg',
      'transforms.operating_status.map.open',
      'transforms.price_level',
      'missing.vision_overall',
      'reasonTemplates.has_phone.yes',
      'gates.0.when',
      'gates.1.id',
      'gates.1.when.not',
      'gates.2.id',
      'gates.2.when.any.0',
      'gates.3.when',
    ]);
    // Paths are arrays: a dotted feature key stays one segment.
    expect(
      profileProblems(
        config({
          weights: { has_phone: 10 },
          transforms: { 'pain_share.booking_friction': { kind: 'linear', min: 0, max: 1 } },
        }),
      )[0]?.path,
    ).toEqual(['transforms', 'pain_share.booking_friction']);
    // A `missing` text the profile can never read (it fills in no value for that feature).
    const dead = profileProblems(
      config({
        weights: { vision_overall: 10 },
        transforms: { vision_overall: { kind: 'linear', min: 0, max: 10 } },
        reasonTemplates: { vision_overall: { missing: { en: 'x', fr: 'x' } } },
      }),
    );
    expect(dead.map((p) => p.path)).toEqual([['reasonTemplates', 'vision_overall', 'missing']]);
    // A missing value for a feature with a registry default can never apply.
    expect(
      profileProblems(config({ weights: { has_phone: 10 }, missing: { has_phone: 1 } })).map((p) => p.path),
    ).toEqual([['missing', 'has_phone']]);
    // A zero weight needs nothing.
    expect(profileProblems(config({ weights: { has_website: 10, rating_avg: 0 } }))).toEqual([]);
  });

  it('turns problems into schema issues at their paths', () => {
    const result = ScoringProfileConfigSchema.safeParse({
      offer: 'new_website',
      weights: { rating_avg: 10 },
      tiers: { A: 60, B: 30 },
      gates: [
        {
          id: 'one',
          when: { all: [{ feature: 'has_phone', gt: 1 }] },
          effect: { type: 'exclude' },
          reason: { en: 'x', fr: 'x' },
        },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      ['transforms', 'rating_avg'],
      ['gates', 0, 'when', 'all', 0],
    ]);
  });

  it('rejects malformed configs at the schema', () => {
    const base = { offer: 'new_website', weights: { has_phone: 10 }, tiers: { A: 60, B: 30 } };
    expect(ScoringProfileConfigSchema.safeParse(base).success).toBe(true);
    expect(ScoringProfileConfigSchema.parse(base)).toMatchObject({ kind: 'rules', missing: {}, gates: [] });
    expect(ScoringProfileConfigSchema.safeParse({ ...base, weights: { has_phone: -5 } }).success).toBe(false);
    expect(ScoringProfileConfigSchema.safeParse({ ...base, weights: { nope: 5 } }).success).toBe(false);
    expect(ScoringProfileConfigSchema.safeParse({ ...base, tiers: { A: 30, B: 30 } }).success).toBe(false);
    expect(ScoringProfileConfigSchema.safeParse({ ...base, missing: { has_phone: 2 } }).success).toBe(false);
    const transform = (value: unknown) =>
      ScoringProfileConfigSchema.safeParse({
        ...base,
        weights: { has_phone: 10, price_level: 5 },
        transforms: { price_level: value },
      }).success;
    expect(transform({ kind: 'linear', min: 1, max: 4 })).toBe(true);
    expect(transform({ kind: 'linear', min: 5, max: 5 })).toBe(false);
    expect(
      transform({
        kind: 'piecewise',
        points: [
          [2, 0],
          [1, 1],
        ],
      }),
    ).toBe(false);
    // Non-decreasing only (every numeric transform is monotone).
    expect(
      transform({
        kind: 'piecewise',
        points: [
          [0, 1],
          [10, 0],
        ],
      }),
    ).toBe(false);
    expect(transform({ kind: 'log', max: 0 })).toBe(false);
    expect(
      ScoringProfileConfigSchema.safeParse({
        ...base,
        gates: [
          {
            id: 'two_ops',
            when: { feature: 'has_phone', eq: true, neq: false },
            effect: { type: 'exclude' },
            reason: { en: 'x', fr: 'x' },
          },
        ],
      }).success,
    ).toBe(false);
  });
});
