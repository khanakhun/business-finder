// When a shadow model may replace the active profile (BF-059, champion–challenger): enough prospective positives,
// and the shadow's top 20% converting at least 1.2× the active top 20% with non-overlapping 90% intervals — or an
// owner's explicit override with a reason. Never automatic: this only says whether the button is allowed.

export interface TopKComparison {
  /** Positives among contacts made since the shadow started (both rankings see the same contacts). */
  readonly positives: number;
  readonly active: { readonly n: number; readonly positives: number };
  readonly shadow: { readonly n: number; readonly positives: number };
}

export interface PromotionCriteria {
  readonly minPositives: number;
  readonly minLift: number;
  /** z for the interval (1.645 = 90%). */
  readonly z: number;
}

export const DEFAULT_PROMOTION_CRITERIA: PromotionCriteria = { minPositives: 30, minLift: 1.2, z: 1.645 };

/** The Wilson score interval of k/n. */
export function wilsonInterval(k: number, n: number, z: number): { low: number; high: number } | null {
  if (n <= 0) return null;
  const p = k / n;
  const z2 = z * z;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

export interface PromotionCheck {
  readonly enoughPositives: boolean;
  readonly lift: number | null;
  readonly liftMet: boolean;
  readonly intervalsSeparate: boolean;
  readonly eligible: boolean;
}

export function checkPromotion(
  comparison: TopKComparison,
  criteria = DEFAULT_PROMOTION_CRITERIA,
): PromotionCheck {
  const activeRate = comparison.active.n > 0 ? comparison.active.positives / comparison.active.n : null;
  const shadowRate = comparison.shadow.n > 0 ? comparison.shadow.positives / comparison.shadow.n : null;
  const lift = activeRate && shadowRate !== null ? shadowRate / activeRate : null;
  const activeInterval = wilsonInterval(comparison.active.positives, comparison.active.n, criteria.z);
  const shadowInterval = wilsonInterval(comparison.shadow.positives, comparison.shadow.n, criteria.z);
  const intervalsSeparate =
    activeInterval !== null && shadowInterval !== null && shadowInterval.low > activeInterval.high;
  const enoughPositives = comparison.positives >= criteria.minPositives;
  const liftMet = lift !== null && lift >= criteria.minLift;
  return {
    enoughPositives,
    lift,
    liftMet,
    intervalsSeparate,
    eligible: enoughPositives && liftMet && intervalsSeparate,
  };
}
