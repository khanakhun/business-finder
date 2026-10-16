import { type FeatureKey, SCORED_PAIN_TAGS } from '@bf/contracts';
import type { BusinessFacts } from '../facts.ts';
import type { FeatureCompute, FeatureComputes } from './feature.ts';

// Pain features (BF-029 insights): the share of analysed reviews raising each pain, and the average sentiment.
// Without analysed reviews nothing is known (null), which is not the same as "no complaint" (0).

const painShare =
  (tag: (typeof SCORED_PAIN_TAGS)[number]): FeatureCompute =>
  (facts: BusinessFacts) =>
    facts.reviews && facts.reviews.sampleSize > 0 ? (facts.reviews.painShare[tag] ?? 0) : null;

export const painFeatures: FeatureComputes = {
  ...(Object.fromEntries(SCORED_PAIN_TAGS.map((tag) => [`pain_share.${tag}`, painShare(tag)])) as Partial<
    Record<FeatureKey, FeatureCompute>
  >),
  sentiment_avg: (facts) => facts.reviews?.sentimentAvg ?? null,
};
