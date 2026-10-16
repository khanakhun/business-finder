import type { ScoringProfileConfig } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import {
  build,
  normalizedWeights,
  reasonKeys,
  toDraft,
  unweighted,
  withoutFeature,
  withWeight,
} from './draft.ts';

const base: ScoringProfileConfig = {
  kind: 'rules',
  offer: 'new_website',
  weights: { has_phone: 30, has_website: -20, rating_avg: 10 },
  transforms: { rating_avg: { kind: 'linear', min: 1, max: 5 } },
  missing: {},
  gates: [],
  tiers: { A: 60, B: 30 },
  normalization: 'weighted_sum',
  reasonTemplates: {},
};

describe('profile draft', () => {
  it('builds the config the server reads, unchanged when nothing was edited', () => {
    expect(build(toDraft(base))).toEqual({ config: base, issues: [] });
  });

  it('reports the problems at their paths: an unknown placeholder, bad tiers, an incomplete gate', () => {
    const config = {
      ...base,
      tiers: { A: 20, B: 30 },
      reasonTemplates: { rating_avg: { value: { en: 'Rated {value}', fr: 'Noté {valeur}' } } },
    };
    const draft = {
      ...toDraft(config),
      gates: [
        {
          id: 'closed',
          effect: { type: 'exclude' },
          reason: { en: 'Closed', fr: 'Fermé' },
          mode: 'rules',
          match: 'all',
          rules: [{ feature: 'rating_avg', op: 'lt', value: '' }],
        },
      ],
    } as const;
    const { config: built, issues } = build(draft);
    expect(built).toBeNull();
    expect(issues.map((issue) => issue.path.join('.'))).toEqual(
      expect.arrayContaining(['gates.0.when', 'tiers', 'reasonTemplates.rating_avg.value.fr']),
    );
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
  });
});
