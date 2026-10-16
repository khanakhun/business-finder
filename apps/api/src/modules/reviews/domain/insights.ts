import {
  EVIDENCE_PER_TAG,
  type EvidenceSnippet,
  PAIN_SIGNAL_TAGS,
  type PainSignalTag,
  type RatingTrend,
  REVIEW_SOURCES,
  type ReviewSource,
} from '@bf/contracts';
import type { ClassifiedReview } from './review.ts';

// Aggregator (BF-029, pure): classified reviews → one source's contribution (sums), contributions → the insights
// a workspace sees. Keeping sums per source lets one source be refreshed, or expire, without the others' part.

export interface SourceContribution {
  readonly sampleSize: number;
  readonly painCounts: Partial<Record<PainSignalTag, number>>;
  readonly sentimentSum: number;
  readonly ownerResponses: number;
  readonly ownerResponseKnown: number;
  readonly evidence: Partial<Record<PainSignalTag, EvidenceSnippet[]>>;
  readonly computedAt: string;
  readonly expiresAt: string | null;
  readonly model: string;
  readonly promptVersion: number;
}

export type Contributions = Partial<Record<ReviewSource, SourceContribution>>;

export interface RatingSummary {
  readonly snapshot: { readonly avg: number; readonly count: number; readonly observedAt: string } | null;
  readonly trend: RatingTrend;
}

export interface CombinedInsights {
  readonly computedAt: string;
  readonly sources: ReviewSource[];
  readonly sampleSize: number;
  readonly painCounts: Partial<Record<PainSignalTag, number>>;
  readonly painShare: Partial<Record<PainSignalTag, number>>;
  readonly sentimentAvg: number | null;
  readonly ownerResponseRate: number | null;
  readonly ratingSnapshot: RatingSummary['snapshot'];
  readonly ratingTrend: RatingTrend;
  readonly evidence: Partial<Record<PainSignalTag, EvidenceSnippet[]>>;
  readonly model: string;
  readonly promptVersion: number;
  readonly expiresAt: string | null;
}

const round = (value: number, digits = 3) => Number(value.toFixed(digits));

/**
 * One source's contribution. A review's owner reply is what its source says, else whether it mentions one — for
 * sources that never say (Google, pasted reviews) the rate is a lower bound.
 */
export function contributionOf(
  reviews: readonly ClassifiedReview[],
  meta: {
    readonly source: ReviewSource;
    readonly computedAt: Date;
    readonly expiresAt: Date | null;
    readonly model: string;
    readonly promptVersion: number;
  },
): SourceContribution {
  const painCounts: Partial<Record<PainSignalTag, number>> = {};
  const evidence: Partial<Record<PainSignalTag, EvidenceSnippet[]>> = {};
  let ownerResponses = 0;
  for (const review of reviews) {
    for (const tag of new Set(review.tags)) {
      painCounts[tag] = (painCounts[tag] ?? 0) + 1;
      const snippets = evidence[tag] ?? [];
      // One snippet per review and tag, distinct texts, at most EVIDENCE_PER_TAG.
      if (
        review.evidence &&
        snippets.length < EVIDENCE_PER_TAG &&
        !snippets.some((s) => s.text.toLowerCase() === review.evidence?.toLowerCase())
      ) {
        snippets.push({
          text: review.evidence,
          language: review.language,
          sourceRef: meta.source,
          expiresAt: meta.expiresAt?.toISOString() ?? null,
        });
        evidence[tag] = snippets;
      }
    }
    if (review.ownerResponded ?? review.mentionsOwnerResponse) ownerResponses += 1;
  }
  return {
    sampleSize: reviews.length,
    painCounts,
    sentimentSum: round(
      reviews.reduce((sum, r) => sum + Math.max(-1, Math.min(1, r.sentiment)), 0),
      6,
    ),
    ownerResponses,
    ownerResponseKnown: reviews.length,
    evidence,
    computedAt: meta.computedAt.toISOString(),
    expiresAt: meta.expiresAt?.toISOString() ?? null,
    model: meta.model,
    promptVersion: meta.promptVersion,
  };
}

/** Contributions still within retention at `now` (an expired source's part is dropped whole). */
export function liveContributions(contributions: Contributions, now: Date): Contributions {
  return Object.fromEntries(
    Object.entries(contributions).filter(
      ([, c]) => c !== undefined && (c.expiresAt === null || Date.parse(c.expiresAt) > now.getTime()),
    ),
  ) as Contributions;
}

/** The insights from the live contributions; null when none is left (or none analysed a review). */
export function combineInsights(
  contributions: Contributions,
  rating: RatingSummary,
  now: Date,
): CombinedInsights | null {
  const live = REVIEW_SOURCES.flatMap((source) => {
    const contribution = liveContributions(contributions, now)[source];
    return contribution && contribution.sampleSize > 0 ? [{ source, contribution }] : [];
  });
  if (live.length === 0) return null;
  const sampleSize = live.reduce((sum, { contribution }) => sum + contribution.sampleSize, 0);
  const painCounts: Partial<Record<PainSignalTag, number>> = {};
  const painShare: Partial<Record<PainSignalTag, number>> = {};
  const evidence: Partial<Record<PainSignalTag, EvidenceSnippet[]>> = {};
  // Newest contribution first: its evidence wins the few slots per tag.
  const newestFirst = [...live].sort((a, b) =>
    b.contribution.computedAt.localeCompare(a.contribution.computedAt),
  );
  for (const tag of PAIN_SIGNAL_TAGS) {
    const count = live.reduce((sum, { contribution }) => sum + (contribution.painCounts[tag] ?? 0), 0);
    if (count > 0) {
      painCounts[tag] = count;
      painShare[tag] = round(count / sampleSize);
    }
    const snippets = newestFirst.flatMap(({ contribution }) => contribution.evidence[tag] ?? []);
    if (snippets.length > 0) evidence[tag] = snippets.slice(0, EVIDENCE_PER_TAG);
  }
  const known = live.reduce((sum, { contribution }) => sum + contribution.ownerResponseKnown, 0);
  const replies = live.reduce((sum, { contribution }) => sum + contribution.ownerResponses, 0);
  const expiries = live.flatMap(({ contribution }) =>
    contribution.expiresAt ? [contribution.expiresAt] : [],
  );
  const newest = (newestFirst[0] as (typeof live)[number]).contribution;
  return {
    computedAt: now.toISOString(),
    sources: live.map(({ source }) => source),
    sampleSize,
    painCounts,
    painShare,
    sentimentAvg: round(
      live.reduce((sum, { contribution }) => sum + contribution.sentimentSum, 0) / sampleSize,
    ),
    ownerResponseRate: known > 0 ? round(replies / known) : null,
    ratingSnapshot: rating.snapshot,
    ratingTrend: rating.trend,
    evidence,
    model: newest.model,
    promptVersion: newest.promptVersion,
    expiresAt: expiries.length > 0 ? (expiries.sort()[0] as string) : null,
  };
}
