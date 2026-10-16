import { describe, expect, it } from 'vitest';
import {
  decide,
  proposeFromMappings,
  rankMappings,
  type StepProposal,
  UNCLASSIFIED,
} from './classification.ts';

const p = (
  origin: StepProposal['origin'],
  primary: string,
  confidence: number,
  secondary: string[] = [],
) => ({
  origin,
  primary,
  confidence,
  secondary,
});

describe('decide', () => {
  it('takes the first proposal at or above the threshold', () => {
    expect(decide([p('mapping', 'bar', 0.95), p('synonym', 'restaurant', 0.99)])).toEqual({
      primary: 'bar',
      secondary: ['restaurant'],
      confidence: 0.95,
      origin: 'mapping',
      needsReview: false,
    });
    expect(decide([null, p('synonym', 'hair_salon', 0.8)])).toMatchObject({
      origin: 'synonym',
      needsReview: false,
    });
  });

  it('falls back to the most confident proposal for review', () => {
    expect(decide([p('mapping', 'store', 0.5), null, p('llm', 'hardware_store', 0.7)])).toEqual({
      primary: 'hardware_store',
      secondary: ['store'],
      confidence: 0.7,
      origin: 'llm',
      needsReview: true,
    });
  });

  it('is unclassified without proposals', () => {
    expect(decide([null, null])).toEqual(UNCLASSIFIED);
  });

  it('caps secondaries at three distinct, non-primary slugs', () => {
    const result = decide([
      p('mapping', 'a', 0.9, ['b', 'c', 'a']),
      p('synonym', 'd', 0.8),
      p('llm', 'e', 0.7),
    ]);
    expect(result.secondary).toEqual(['b', 'c', 'd']);
  });
});

describe('mappings', () => {
  it('ranks human over seed over llm, then by confidence', () => {
    const ranked = rankMappings([
      { slug: 'llm_pick', origin: 'llm', confidence: 0.99 },
      { slug: 'seed_low', origin: 'seed', confidence: 0.6 },
      { slug: 'human_pick', origin: 'human', confidence: 0.5 },
      { slug: 'seed_high', origin: 'seed', confidence: 0.9 },
    ]);
    expect(ranked.map((m) => m.slug)).toEqual(['human_pick', 'seed_high', 'seed_low', 'llm_pick']);
  });

  it('proposes the best mapping with the others as secondaries', () => {
    expect(
      proposeFromMappings([
        { slug: 'restaurant', origin: 'seed', confidence: 0.9 },
        { slug: 'bar', origin: 'seed', confidence: 0.95 },
        { slug: 'bar', origin: 'seed', confidence: 0.8 },
      ]),
    ).toEqual({ origin: 'mapping', primary: 'bar', secondary: ['restaurant'], confidence: 0.95 });
    expect(proposeFromMappings([])).toBeNull();
  });
});
