import type { MatchScore, SourceProvider } from '@bf/contracts';

// Stage 5 (BF-016): match, create with a possible-duplicate flag, or create.

export interface ResolutionThresholds {
  /** At or above: the record is the same business. */
  readonly match: number;
  /** At or above (below `match`): a new business, flagged as a possible duplicate for review. */
  readonly possible: number;
  /** Per-provider adjustment added to both thresholds (noisier sources need more evidence). */
  readonly providerAdjustments: Partial<Record<SourceProvider, number>>;
}

export const DEFAULT_THRESHOLDS: ResolutionThresholds = {
  match: 0.85,
  possible: 0.6,
  providerAdjustments: { gmaps_scraper: 0.05 },
};

export interface ScoredCandidate {
  readonly businessId: string;
  readonly score: MatchScore;
}

export type MatchDecision =
  | {
      readonly kind: 'match';
      readonly businessId: string;
      readonly score: MatchScore;
      /** Other candidates above the possible threshold: maybe duplicates of the match. */
      readonly possible: readonly ScoredCandidate[];
    }
  | { readonly kind: 'create'; readonly possible: readonly ScoredCandidate[] };

/** Highest score wins; ties go to the smaller business id (deterministic). */
export function decideMatch(
  candidates: readonly ScoredCandidate[],
  provider: SourceProvider,
  thresholds: ResolutionThresholds = DEFAULT_THRESHOLDS,
): MatchDecision {
  const adjust = thresholds.providerAdjustments[provider] ?? 0;
  const ranked = [...candidates].sort(
    (a, b) => b.score.total - a.score.total || a.businessId.localeCompare(b.businessId),
  );
  const possible = ranked.filter((c) => c.score.total >= thresholds.possible + adjust);
  const [best] = ranked;
  if (best && best.score.total >= thresholds.match + adjust) {
    return { kind: 'match', businessId: best.businessId, score: best.score, possible: possible.slice(1) };
  }
  return { kind: 'create', possible };
}
