import type { ReviewSource, ReviewsUsage } from '@bf/contracts';
import type { CombinedInsights, Contributions } from '../domain/insights.ts';
import type { RatingObservation } from '../domain/rating-trend.ts';
import type { ClassifiedReview, PreparedReview, ReviewBatch } from '../domain/review.ts';

// Ports of the reviews module (BF-029).

/** What sources and the classifier know about the business (golden record and provider references). */
export interface ReviewSubject {
  readonly businessId: string;
  readonly displayName: string;
  readonly location: { readonly lat: number; readonly lng: number } | null;
  /** Primary category label, e.g. "Restaurant" (classifier context). */
  readonly categoryLabel: string | null;
  /** Google place id, when a Google source record is linked (place ids may be kept indefinitely). */
  readonly googlePlaceId: string | null;
  /** Scraper place id or cid, when a scraper record is linked. */
  readonly scraperRefs: readonly string[];
  readonly rating: { readonly avg: number; readonly count: number } | null;
  /** The business's main language (French in French-speaking countries). */
  readonly locale: 'en' | 'fr';
}

export const REVIEW_SUBJECTS = Symbol('REVIEW_SUBJECTS');
export interface ReviewSubjectReader {
  find(businessId: string): Promise<ReviewSubject | undefined>;
  /** Whether the workspace tracks the business (org-scoped access). */
  tracks(organizationId: string, businessId: string): Promise<boolean>;
}

export interface ReviewFetchContext {
  readonly organizationId: string;
  readonly subject: ReviewSubject;
  readonly signal: AbortSignal;
  /** Distinguishes one fetch from the next (a step attempt), for sources that work asynchronously. */
  readonly attemptKey: string;
}

export type ReviewFetch =
  | { readonly kind: 'reviews'; readonly batch: ReviewBatch }
  /** The source has nothing for this business (no place id, no reviews). */
  | { readonly kind: 'none' }
  /** The source is working (a scraper job): ask again later. */
  | { readonly kind: 'pending'; readonly retryAfterMs: number };

/** A source of review text (Strategy): Google Places, the scraper. Manual paste does not fetch. */
export interface ReviewSourceAdapter {
  readonly source: Exclude<ReviewSource, 'manual'>;
  /** Estimated cost of one fetch, for budgets. */
  readonly estimatedCostUsd: number;
  fetch(context: ReviewFetchContext): Promise<ReviewFetch>;
}
export const REVIEW_SOURCE_ADAPTERS = Symbol('REVIEW_SOURCE_ADAPTERS');

export interface ClassificationResult {
  /** One entry per prepared review, in order; null when the model's answer for it could not be used. */
  readonly reviews: ReadonlyArray<ClassifiedReview | null>;
  readonly costUsd: number;
  readonly model: string;
  readonly promptVersion: number;
}

/** Tags prepared (already anonymized) reviews: the LLM task, or a fake in tests and E2E. */
export interface ReviewClassifier {
  classify(
    organizationId: string,
    reviews: readonly PreparedReview[],
    context: {
      readonly categoryLabel: string | null;
      readonly locale: 'en' | 'fr';
      readonly signal?: AbortSignal;
    },
  ): Promise<ClassificationResult>;
}
export const REVIEW_CLASSIFIER = Symbol('REVIEW_CLASSIFIER');

/** What the model said about one review: what the classification cache keeps. */
export type CachedVerdict = Pick<
  ClassifiedReview,
  'tags' | 'sentiment' | 'mentionsOwnerResponse' | 'evidence'
> & {
  readonly model: string;
  readonly promptVersion: number;
};

/** Per-review classification cache (keyed by a hash of the anonymized text; per workspace). */
export interface ReviewClassificationCache {
  getMany(organizationId: string, keys: readonly string[]): Promise<Map<string, CachedVerdict>>;
  setMany(
    organizationId: string,
    entries: ReadonlyMap<string, CachedVerdict>,
    ttlSeconds: number,
  ): Promise<void>;
}
export const REVIEW_CLASSIFICATION_CACHE = Symbol('REVIEW_CLASSIFICATION_CACHE');

export interface InsightsRow {
  readonly combined: CombinedInsights;
  readonly contributions: Contributions;
}

/** Insights per workspace and business, with the per-source contributions they are rebuilt from. */
export interface ReviewInsightsRepository {
  find(organizationId: string, businessId: string): Promise<InsightsRow | undefined>;
  /** Same, locking the row until the transaction ends (concurrent analyses merge, never overwrite). */
  findForUpdate(organizationId: string, businessId: string): Promise<InsightsRow | undefined>;
  save(organizationId: string, businessId: string, row: InsightsRow): Promise<void>;
  delete(organizationId: string, businessId: string): Promise<void>;
  /** Rows whose earliest contribution expired before `now`. */
  expiring(now: Date, limit: number): Promise<Array<{ organizationId: string; businessId: string }>>;
  /** The workspace's businesses with a contribution from `source`. */
  withSource(organizationId: string, source: ReviewSource): Promise<string[]>;
}
export const REVIEW_INSIGHTS = Symbol('REVIEW_INSIGHTS');

export interface RatingObservationRepository {
  record(businessId: string, observation: RatingObservation, expiresAt: Date | null): Promise<void>;
  /** Observations not expired at `now` and not after it. */
  list(businessId: string, now: Date): Promise<RatingObservation[]>;
  purgeExpired(now: Date): Promise<number>;
}
export const RATING_OBSERVATIONS = Symbol('RATING_OBSERVATIONS');

export interface ReviewSourceSettingsRepository {
  list(organizationId: string): Promise<Partial<Record<ReviewSource, ReviewsUsage>>>;
  set(
    organizationId: string,
    source: ReviewSource,
    usage: ReviewsUsage,
    userId: string | null,
  ): Promise<void>;
}
export const REVIEW_SOURCE_SETTINGS = Symbol('REVIEW_SOURCE_SETTINGS');

/** Whether the Google Maps scraper may run for the workspace (its own three gates, BF-019). */
export interface ScraperGate {
  allowed(organizationId: string): Promise<boolean>;
}
export const SCRAPER_GATE = Symbol('SCRAPER_GATE');
