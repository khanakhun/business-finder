import { describe, expect, it } from 'vitest';
import { PAIN_SIGNAL_TAGS } from './reviews.ts';
import {
  FEATURE_DEFINITIONS,
  FEATURE_KEYS,
  FeatureVectorSchema,
  GateConditionSchema,
  SCORED_PAIN_TAGS,
  ScoreResultSchema,
} from './scoring.ts';

describe('scoring contracts', () => {
  it('defines one pain feature per scored pain tag, and EN/FR texts for every feature', () => {
    expect(SCORED_PAIN_TAGS).toEqual(PAIN_SIGNAL_TAGS.filter((tag) => tag !== 'other'));
    for (const tag of SCORED_PAIN_TAGS) expect(FEATURE_KEYS).toContain(`pain_share.${tag}`);
    for (const key of FEATURE_KEYS) {
      const { description, reasons, type, values } = FEATURE_DEFINITIONS[key];
      expect(description.en && description.fr, key).toBeTruthy();
      for (const [value, text] of Object.entries(reasons)) {
        expect(text?.en && text.fr, `${key}.${value}`).toBeTruthy();
        if (type === 'boolean') expect(['true', 'false', 'value']).toContain(value);
        if (type === 'enum') expect([...(values ?? []), 'value']).toContain(value);
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
