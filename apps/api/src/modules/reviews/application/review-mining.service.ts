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
  liveContributions,
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
const MAX_PURGE_BATCHES = 100;
const FORGET_CHUNK = 100;
const MAX_FORGET_CHUNKS = 1_000;
const DAY_MS = 86_400_000;

export interface AnalysisOutcome {
  /** Reviews the classifier could tag (personal details removed, answer validated). */
  readonly analysed: number;
  readonly costUsd: number;
  readonly insights: CombinedInsights | null;
  /** The source's gate closed before storing: nothing was kept. */
  readonly dropped?: boolean;
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
    options: {
      readonly signal?: AbortSignal;
      /**
       * Whether the source's gate is still open, asked again under the lock just before storing (a gate turned off
       * while the reviews were being classified stores nothing).
       */
      readonly allowed?: () => Promise<boolean>;
    } = {},
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
    const result = await this.classifier
      .classify(organizationId, prepared, {
        source: batch.source,
        categoryLabel: subject.categoryLabel,
        locale: subject.locale,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      .catch(async (error: unknown) => {
        // Batches classified before the failure are cached: a gate closed meanwhile must not keep them.
        if (options.allowed && !(await options.allowed().catch(() => false))) {
          await this.classifier.forget(organizationId, batch.source);
        }
        throw error;
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
    const merged = await this.merge(
      organizationId,
      subject.businessId,
      batch.source,
      contribution,
      options.allowed,
    );
    return {
      analysed: merged.stored ? classified.length : 0,
      ...(merged.stored ? {} : { dropped: true }),
      costUsd: result.costUsd,
      insights: merged.insights,
    };
  }

  /**
   * The insights from the contributions still live at `now`, with the rating of the sources this workspace uses
   * (another workspace's Google key, or a source turned off or expired here, does not feed it). Writes nothing: the
   * read side uses it between an expiry and the nightly purge.
   */
  async combinedAt(
    businessId: string,
    contributions: Contributions,
    now: Date,
  ): Promise<CombinedInsights | null> {
    const live = liveContributions(contributions, now);
    // The golden record's rating is a shared golden-record fact (shown with the business anyway); it joins the
    // trend only while a live source is there.
    const used = new Set<string>([
      ...(Object.keys(live).length > 0 ? ['golden_record'] : []),
      ...Object.keys(live),
    ]);
    const rating = ratingSummary(
      (await this.ratings.list(businessId, now)).filter((o) => used.has(o.source)),
    );
    return combineInsights(contributions, rating, now);
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

  /**
   * Drops a source's part of the workspace's insights (its gate was turned off). Holds the source's lock: a merge of
   * that source either committed before (and is removed here) or waits and then finds the gate closed.
   */
  async forgetSource(organizationId: string, source: ReviewSource): Promise<number> {
    let forgotten = 0;
    // Chunks, each its own short transaction: merges of other sources are never blocked for long. The gate is
    // already closed (its audit entry committed first), so a merge between chunks finds it closed and stores nothing.
    for (let chunk = 0; chunk < MAX_FORGET_CHUNKS; chunk++) {
      const done = await this.forgetChunk(organizationId, source);
      forgotten += done;
      if (done < FORGET_CHUNK) break;
    }
    // After the rows: a classification still running for this source forgets its own verdicts (see `analyze`).
    await this.classifier.forget(organizationId, source);
    return forgotten;
  }

  /** Up to FORGET_CHUNK businesses, in id order (two forgets lock businesses in the same order: no deadlock). */
  @Transactional()
  private async forgetChunk(organizationId: string, source: ReviewSource): Promise<number> {
    await this.insights.lockSource(organizationId, source, 'exclusive');
    const businesses = await this.insights.withSource(organizationId, source, FORGET_CHUNK);
    for (const businessId of businesses) await this.apply(organizationId, businessId, source, null);
    return businesses.length;
  }

  /** Retention (nightly): expired contributions and their evidence go, the rest is recombined. */
  async purgeExpired(now: Date, batchSize = 500): Promise<number> {
    let purged = 0;
    // Batches until nothing expired is left (bounded: a stuck row cannot loop forever).
    for (let batch = 0; batch < MAX_PURGE_BATCHES; batch++) {
      const expiring = await this.insights.expiring(now, batchSize);
      let failed = 0;
      for (const { organizationId, businessId } of expiring) {
        try {
          await this.recombine(organizationId, businessId, now);
          purged += 1;
        } catch (error) {
          failed += 1;
          this.logger.error({ err: error, businessId }, 'review insights purge failed for a business');
        }
      }
      // A batch of failures only would come back forever: stop for tonight.
      if (expiring.length < batchSize || failed === expiring.length) break;
    }
    purged += await this.ratings.purgeExpired(now);
    return purged;
  }

  /**
   * Stores one source's contribution: under the source's shared lock (see `forgetSource`) the gate is asked again,
   * then the business's lock serializes merges (a missing row cannot be locked by `FOR UPDATE`).
   */
  @Transactional()
  private async merge(
    organizationId: string,
    businessId: string,
    source: ReviewSource,
    contribution: SourceContribution,
    allowed: (() => Promise<boolean>) | undefined,
  ): Promise<{ readonly stored: boolean; readonly insights: CombinedInsights | null }> {
    await this.insights.lockSource(organizationId, source, 'shared');
    if (allowed && !(await allowed())) {
      this.logger.info({ businessId, source }, 'review source turned off meanwhile: contribution dropped');
      await this.classifier.forget(organizationId, source);
      return {
        stored: false,
        insights: (await this.insights.find(organizationId, businessId))?.combined ?? null,
      };
    }
    return { stored: true, insights: await this.apply(organizationId, businessId, source, contribution) };
  }

  /** Replaces (or, with null, removes) one source's contribution under the business's lock, then recombines. */
  private async apply(
    organizationId: string,
    businessId: string,
    source: ReviewSource,
    contribution: SourceContribution | null,
  ): Promise<CombinedInsights | null> {
    await this.insights.lockBusiness(organizationId, businessId);
    const current = await this.insights.find(organizationId, businessId);
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
    await this.insights.lockBusiness(organizationId, businessId);
    const current = await this.insights.find(organizationId, businessId);
    return this.store(organizationId, businessId, current?.contributions ?? {}, now);
  }

  private async store(
    organizationId: string,
    businessId: string,
    contributions: Contributions,
    now: Date,
  ): Promise<CombinedInsights | null> {
    const combined = await this.combinedAt(businessId, contributions, now);
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
