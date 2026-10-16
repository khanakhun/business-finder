import { REVIEW_TEXT_BUDGET } from '@bf/ai';
import { type Clock, REVIEW_SOURCE_LICENSING, type ReviewSource } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { LOGGER } from '../../platform/logging/logger.ts';
import {
  type CombinedInsights,
  type Contributions,
  combineInsights,
  contributionOf,
  type SourceContribution,
} from '../domain/insights.ts';
import { detectLanguage } from '../domain/language.ts';
import { stripPersonalDetails } from '../domain/personal-details.ts';
import { ratingSummary } from '../domain/rating-trend.ts';
import type { ClassifiedReview, PreparedReview, ReviewBatch } from '../domain/review.ts';
import {
  RATING_OBSERVATIONS,
  type RatingObservationRepository,
  REVIEW_CLASSIFIER,
  REVIEW_INSIGHTS,
  type ReviewClassifier,
  type ReviewInsightsRepository,
  type ReviewSubject,
} from './ports.ts';

/** Reviews analysed per source and analysis (Google returns at most 5; a paste at most 50). */
export const MAX_REVIEWS_PER_SOURCE = 50;
const DAY_MS = 86_400_000;

export interface AnalysisOutcome {
  /** Reviews the classifier could tag (personal details removed, answer validated). */
  readonly analysed: number;
  readonly costUsd: number;
  readonly insights: CombinedInsights | null;
}

/** When a source's derived data expires (its licensing retention), from when it was fetched. */
export function expiryOf(source: ReviewSource, fetchedAt: Date): Date | null {
  const days = REVIEW_SOURCE_LICENSING[source].retentionDays;
  return days === null ? null : new Date(fetchedAt.getTime() + days * DAY_MS);
}

/**
 * Review mining (BF-029): anonymizes a source's reviews, classifies them, and merges the source's contribution into
 * the workspace's insights for the business. The review text lives only in this call: what is stored is counts,
 * sums and checked paraphrases, each expiring with its source's licence.
 */
@Injectable()
export class ReviewMiningService {
  constructor(
    @Inject(REVIEW_CLASSIFIER) private readonly classifier: ReviewClassifier,
    @Inject(REVIEW_INSIGHTS) private readonly insights: ReviewInsightsRepository,
    @Inject(RATING_OBSERVATIONS) private readonly ratings: RatingObservationRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Personal details out, language in; reviews left empty by the stripping are dropped. */
  prepare(batch: ReviewBatch): PreparedReview[] {
    return batch.reviews.slice(0, MAX_REVIEWS_PER_SOURCE).flatMap((review) => {
      const text = stripPersonalDetails(review.text, review.knownNames).slice(0, REVIEW_TEXT_BUDGET).trim();
      if (text.length < 2) return [];
      return [
        {
          text,
          ...(review.rating !== undefined ? { rating: review.rating } : {}),
          language: detectLanguage(text, review.language),
          ownerResponded: review.ownerResponded,
        },
      ];
    });
  }

  async analyze(
    organizationId: string,
    subject: ReviewSubject,
    batch: ReviewBatch,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<AnalysisOutcome> {
    const prepared = this.prepare(batch);
    const expiresAt = expiryOf(batch.source, batch.fetchedAt);
    // A source's own rating summary feeds the trend (pasted reviews come without one).
    if (batch.rating && batch.source !== 'manual') {
      await this.ratings.record(
        subject.businessId,
        { source: batch.source, ...batch.rating, observedAt: batch.fetchedAt },
        expiresAt,
      );
    }
    if (prepared.length === 0) {
      return {
        analysed: 0,
        costUsd: 0,
        insights: (await this.insights.find(organizationId, subject.businessId))?.combined ?? null,
      };
    }
    const result = await this.classifier.classify(organizationId, prepared, {
      categoryLabel: subject.categoryLabel,
      locale: subject.locale,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const classified = result.reviews.filter((r): r is ClassifiedReview => r !== null);
    if (classified.length < prepared.length) {
      this.logger.warn(
        {
          businessId: subject.businessId,
          source: batch.source,
          dropped: prepared.length - classified.length,
        },
        'review answers dropped (missing or invalid)',
      );
    }
    if (classified.length === 0) {
      return {
        analysed: 0,
        costUsd: result.costUsd,
        insights: (await this.insights.find(organizationId, subject.businessId))?.combined ?? null,
      };
    }
    const contribution = contributionOf(classified, {
      source: batch.source,
      computedAt: this.clock.now(),
      expiresAt,
      model: result.model,
      promptVersion: result.promptVersion,
    });
    const insights = await this.merge(organizationId, subject.businessId, batch.source, contribution);
    return { analysed: classified.length, costUsd: result.costUsd, insights };
  }

  /**
   * Notes the golden record's rating for the trend.
   * DECISION(BF-029): its provenance is usually Google, so it is kept within Google's 30-day caching limit.
   */
  async observeGoldenRating(subject: ReviewSubject): Promise<void> {
    if (!subject.rating) return;
    const now = this.clock.now();
    await this.ratings.record(
      subject.businessId,
      { source: 'golden_record', ...subject.rating, observedAt: now },
      expiryOf('google_places', now),
    );
  }

  /** Drops a source's part of the workspace's insights (its gate was turned off). */
  async forgetSource(organizationId: string, source: ReviewSource): Promise<number> {
    const businesses = await this.insights.withSource(organizationId, source);
    for (const businessId of businesses) await this.merge(organizationId, businessId, source, null);
    return businesses.length;
  }

  /** Retention (nightly): expired contributions and their evidence go, the rest is recombined. */
  async purgeExpired(now: Date, batchSize = 500): Promise<number> {
    let purged = 0;
    for (const { organizationId, businessId } of await this.insights.expiring(now, batchSize)) {
      await this.recombine(organizationId, businessId, now);
      purged += 1;
    }
    purged += await this.ratings.purgeExpired(now);
    return purged;
  }

  /** Replaces (or, with null, removes) one source's contribution under a row lock, then recombines. */
  @Transactional()
  private async merge(
    organizationId: string,
    businessId: string,
    source: ReviewSource,
    contribution: SourceContribution | null,
  ): Promise<CombinedInsights | null> {
    const current = await this.insights.findForUpdate(organizationId, businessId);
    const contributions: Contributions = { ...current?.contributions };
    if (contribution) contributions[source] = contribution;
    else delete contributions[source];
    return this.store(organizationId, businessId, contributions, this.clock.now());
  }

  @Transactional()
  private async recombine(
    organizationId: string,
    businessId: string,
    now: Date,
  ): Promise<CombinedInsights | null> {
    const current = await this.insights.findForUpdate(organizationId, businessId);
    return this.store(organizationId, businessId, current?.contributions ?? {}, now);
  }

  private async store(
    organizationId: string,
    businessId: string,
    contributions: Contributions,
    now: Date,
  ): Promise<CombinedInsights | null> {
    const rating = ratingSummary(await this.ratings.list(businessId, now));
    const combined = combineInsights(contributions, rating, now);
    if (!combined) {
      await this.insights.delete(organizationId, businessId);
      return null;
    }
    // Expired contributions are not kept around: they could no longer be shown anyway.
    const live = Object.fromEntries(
      combined.sources.map((source) => [source, contributions[source]]),
    ) as Contributions;
    await this.insights.save(organizationId, businessId, { combined, contributions: live });
    return combined;
  }
}
