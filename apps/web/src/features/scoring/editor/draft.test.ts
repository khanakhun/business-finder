import type { ScoringProfileConfig } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import {
  build,
  defaultTransform,
  normalizedWeights,
  reasonKeys,
  toDraft,
  transformKinds,
  transformOfKind,
  unweighted,
  withoutFeature,
  withWeight,
} from './draft.ts';
import type { GateDraft } from './gates.ts';

const base: ScoringProfileConfig = {
  kind: 'rules',
  model: null,
  offer: 'new_website',
  weights: { has_phone: 30, has_website: -20, rating_avg: 10 },
  transforms: { rating_avg: { kind: 'linear', min: 1, max: 5 } },
  missing: {},
  gates: [],
  tiers: { A: 60, B: 30 },
  normalization: 'weighted_sum',
  reasonTemplates: {},
};

const rule = (id: string, value: string): GateDraft => ({
  id,
  effect: { type: 'exclude' },
  reason: { en: 'Low', fr: 'Bas' },
  mode: 'rules',
  match: 'all',
  rules: [{ feature: 'rating_avg', op: 'lt', value }],
});

describe('profile draft', () => {
  it('builds the config the server reads, unchanged when nothing was edited', () => {
    expect(build(toDraft(base))).toEqual({ config: base, issues: [] });
  });

  it('reports the problems at their paths with their codes: a placeholder, the tiers, an incomplete rule', () => {
    const config = {
      ...base,
      tiers: { A: 20, B: 30 },
      reasonTemplates: { rating_avg: { value: { en: 'Rated {value}', fr: 'Noté {valeur}' } } },
    };
    const draft = { ...toDraft(config), gates: [rule('first', '')] };
    const { config: built, issues } = build(draft);
    expect(built).toBeNull();
    expect(issues.map(({ path, code }) => ({ path: path.join('.'), code }))).toEqual([
      { path: 'gates.0.when', code: 'incomplete_gate' },
      { path: 'tiers', code: 'tiers_order' },
      { path: 'reasonTemplates.rating_avg.value.fr', code: 'placeholder_unknown' },
    ]);
  });

  it('names the rule the user sees when an earlier one is incomplete', () => {
    const draft = { ...toDraft(base), gates: [rule('dup', ''), rule('dup', '2'), rule('dup', '3')] };
    expect(build(draft).issues.map(({ path, code }) => ({ path: path.join('.'), code }))).toEqual([
      { path: 'gates.0.when', code: 'incomplete_gate' },
      { path: 'gates.2.id', code: 'gate_id_taken' },
    ]);
  });

  it('reports a half-written reason as a schema problem at its language', () => {
    const config = { ...base, reasonTemplates: { rating_avg: { value: { en: 'Rated {value}', fr: '' } } } };
    expect(build(toDraft(config)).issues).toEqual([
      expect.objectContaining({
        path: ['reasonTemplates', 'rating_avg', 'value', 'fr'],
        code: 'schema:too_small',
      }),
    ]);
  });

  it('shares weights over the positive ones', () => {
    expect(Object.fromEntries(normalizedWeights(base.weights))).toEqual({
      has_phone: 0.75,
      has_website: -0.5,
      rating_avg: 0.25,
    });
  });

  it('adds a feature with a starting transform, and removes everything about it', () => {
    const added = withWeight(base, 'operating_status', 5);
    expect(added.transforms.operating_status).toMatchObject({ kind: 'enumMap', default: 0 });
    expect(unweighted(added)).not.toContain('operating_status');
    const removed = withoutFeature(added, 'rating_avg');
    expect(removed.weights.rating_avg).toBeUndefined();
    expect(removed.transforms.rating_avg).toBeUndefined();
    // A weight change keeps the transform as edited.
    expect(withWeight(base, 'rating_avg', 40).transforms.rating_avg).toEqual(base.transforms.rating_avg);
  });

  it('lists the reason keys a feature reads', () => {
    expect(reasonKeys('has_phone', base)).toEqual(['true', 'false', 'value']);
    expect(reasonKeys('operating_status', base)).toContain('closed_permanently');
    expect(reasonKeys('sentiment_avg', { ...base, missing: { sentiment_avg: 0.5 } })).toEqual([
      'below',
      'above',
      'value',
      'missing',
    ]);
  });

  it('has no shares when no weight is positive', () => {
    expect(Object.fromEntries(normalizedWeights({ has_phone: -10, has_website: 0 }))).toEqual({
      has_phone: 0,
      has_website: 0,
    });
  });

  it('removes a feature’s missing value and reason texts too', () => {
    const config = {
      ...base,
      weights: { ...base.weights, sentiment_avg: 5 },
      transforms: { ...base.transforms, sentiment_avg: { kind: 'linear', min: -1, max: 1 } as const },
      missing: { sentiment_avg: 0.5 },
      reasonTemplates: { sentiment_avg: { value: { en: 'Mood {value}', fr: 'Humeur {value}' } } },
    };
    const removed = withoutFeature(config, 'sentiment_avg');
    expect(removed.missing).toEqual({});
    expect(removed.reasonTemplates).toEqual({});
  });

  it('needs no transform for a feature already on 0–1, and the draft still builds', () => {
    expect(defaultTransform('owner_response_rate')).toBeUndefined();
    const added = withWeight(base, 'owner_response_rate', 10);
    expect(added.transforms.owner_response_rate).toBeUndefined();
    expect(build(toDraft(added)).issues).toEqual([]);
  });

  it('offers the transforms that fit, seeded from the feature', () => {
    expect(transformKinds('rating_avg')).toEqual(['linear', 'inverse', 'piecewise', 'log']);
    expect(transformKinds('has_phone')).toEqual(['boolean']);
    for (const kind of transformKinds('rating_avg')) {
      const config = {
        ...base,
        transforms: { ...base.transforms, rating_avg: transformOfKind('rating_avg', kind) },
      };
      expect(build(toDraft(config)).issues, kind).toEqual([]);
    }
    expect(transformOfKind('operating_status', 'enumMap')).toMatchObject({ kind: 'enumMap', default: 0 });
  });
});
