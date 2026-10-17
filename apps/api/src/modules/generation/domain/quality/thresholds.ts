// The quality pipeline's thresholds (BF-045, Specification): the platform's minimums, which a workspace may tighten
// but never loosen. Lighthouse and the visual critic's numbers start from the ticket and get calibrated with data.

export interface QualityThresholds {
  /** Lighthouse categories (0–100), mobile and desktop alike. */
  readonly lighthouse: {
    readonly performance: number;
    readonly accessibility: number;
    readonly bestPractices: number;
    readonly seo: number;
  };
  /** The visual critic: weighted average (1–5) to pass, and the lowest single criterion allowed. */
  readonly visual: { readonly minAverage: number; readonly minCriterion: number };
}

export const PLATFORM_MINIMUMS: QualityThresholds = {
  lighthouse: { performance: 90, accessibility: 95, bestPractices: 95, seo: 90 },
  visual: { minAverage: 3.5, minCriterion: 3 },
};

export type ThresholdOverrides = {
  readonly lighthouse?: Partial<QualityThresholds['lighthouse']>;
  readonly visual?: Partial<QualityThresholds['visual']>;
};

/** A workspace's thresholds: each override applies only when it is stricter than the platform's. */
export function tighten(base: QualityThresholds, overrides: ThresholdOverrides = {}): QualityThresholds {
  const higher = (value: number | undefined, min: number) =>
    value !== undefined && value > min ? value : min;
  return {
    lighthouse: {
      performance: higher(overrides.lighthouse?.performance, base.lighthouse.performance),
      accessibility: higher(overrides.lighthouse?.accessibility, base.lighthouse.accessibility),
      bestPractices: higher(overrides.lighthouse?.bestPractices, base.lighthouse.bestPractices),
      seo: higher(overrides.lighthouse?.seo, base.lighthouse.seo),
    },
    visual: {
      minAverage: Math.min(5, higher(overrides.visual?.minAverage, base.visual.minAverage)),
      minCriterion: Math.min(5, higher(overrides.visual?.minCriterion, base.visual.minCriterion)),
    },
  };
}
