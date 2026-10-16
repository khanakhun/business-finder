import type { FeatureKey, FeatureValue, Offer } from '@bf/contracts';
import type { BusinessFacts, SiteFacts } from '../facts.ts';

// A feature computes one value of the vector from the facts (pure). `null` means the facts do not tell: the
// registry's `missingDefault` stands in, else the feature contributes nothing.

export interface FeatureContext {
  /** The offer of the profile being scored (`category_offer_relevance`). */
  readonly offer: Offer;
}

export type FeatureCompute = (facts: BusinessFacts, context: FeatureContext) => FeatureValue;
export type FeatureComputes = Partial<Record<FeatureKey, FeatureCompute>>;

/** The crawl read a live page of the business (not parked, blocked, broken or a social profile). */
export const readableSite = (facts: BusinessFacts): SiteFacts | null => {
  const site = facts.site;
  return site && !site.socialOnly && (site.reachability === 'ok' || site.reachability === 'redirected')
    ? site
    : null;
};

/** Rounded so that stored vectors and their hashes do not depend on float noise. */
export const round = (value: number, digits = 4): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const DAY_MS = 86_400_000;

/** Whole days from `from` to the facts' `asOf` (never negative). */
export const daysSince = (facts: BusinessFacts, from: string): number =>
  Math.max(0, Math.floor((Date.parse(facts.asOf) - Date.parse(from)) / DAY_MS));
