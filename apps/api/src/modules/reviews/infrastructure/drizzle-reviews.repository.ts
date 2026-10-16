import type { ReviewSource, ReviewsUsage } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import {
  businessCategories,
  businesses,
  businessRatingObservations,
  businessSources,
  categories,
  orgBusinesses,
  reviewInsights,
  reviewSourceSettings,
} from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type {
  InsightsRow,
  RatingObservationRepository,
  ReviewInsightsRepository,
  ReviewSourceSettingsRepository,
  ReviewSubject,
  ReviewSubjectReader,
} from '../application/ports.ts';
import type { Contributions } from '../domain/insights.ts';
import type { RatingObservation } from '../domain/rating-trend.ts';

/** French-speaking countries (the classifier's reader language). */
const FRENCH = new Set([
  'FR',
  'BL',
  'MF',
  'GP',
  'MQ',
  'GF',
  'RE',
  'YT',
  'PM',
  'NC',
  'PF',
  'WF',
  'BE',
  'CH',
  'LU',
  'MC',
]);
/** Two observations of one source closer than this are one (a re-run the same day adds nothing to a trend). */
const OBSERVATION_DEDUP_MS = 12 * 3_600_000;

@Injectable()
export class DrizzleReviewInsightsRepository implements ReviewInsightsRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async lockBusiness(organizationId: string, businessId: string): Promise<void> {
    const key = `reviews:business:${organizationId}:${businessId}`;
    await getExecutor(this.db).execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }

  async lockSource(
    organizationId: string,
    source: ReviewSource,
    mode: 'shared' | 'exclusive',
  ): Promise<void> {
    const key = `reviews:source:${organizationId}:${source}`;
    await getExecutor(this.db).execute(
      mode === 'shared'
        ? sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`
        : sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
  }

  async find(organizationId: string, businessId: string): Promise<InsightsRow | undefined> {
    const [row] = await getExecutor(this.db)
      .select()
      .from(reviewInsights)
      .where(
        and(eq(reviewInsights.organizationId, organizationId), eq(reviewInsights.businessId, businessId)),
      );
    if (!row) return undefined;
    return {
      contributions: row.sourceStats as Contributions,
      combined: {
        computedAt: row.computedAt.toISOString(),
        sources: row.sources,
        sampleSize: row.sampleSize,
        painCounts: row.painCounts,
        painShare: row.painShare,
        sentimentAvg: row.sentimentAvg,
        ownerResponseRate: row.ownerResponseRate,
        ratingSnapshot: row.ratingSnapshot ?? null,
        ratingTrend: row.ratingTrend,
        evidence: row.evidence,
        model: row.model,
        promptVersion: row.promptVersion,
        expiresAt: row.expiresAt?.toISOString() ?? null,
      },
    };
  }

  async save(
    organizationId: string,
    businessId: string,
    { combined, contributions }: InsightsRow,
  ): Promise<void> {
    const values = {
      computedAt: new Date(combined.computedAt),
      sources: combined.sources,
      sampleSize: combined.sampleSize,
      painCounts: combined.painCounts,
      painShare: combined.painShare,
      sentimentAvg: combined.sentimentAvg,
      ownerResponseRate: combined.ownerResponseRate,
      ratingSnapshot: combined.ratingSnapshot,
      ratingTrend: combined.ratingTrend,
      evidence: combined.evidence,
      sourceStats: contributions,
      model: combined.model,
      promptVersion: combined.promptVersion,
      expiresAt: combined.expiresAt ? new Date(combined.expiresAt) : null,
    };
    await getExecutor(this.db)
      .insert(reviewInsights)
      .values({ organizationId, businessId, ...values })
      .onConflictDoUpdate({
        target: [reviewInsights.organizationId, reviewInsights.businessId],
        set: values,
      });
  }

  async delete(organizationId: string, businessId: string): Promise<void> {
    await getExecutor(this.db)
      .delete(reviewInsights)
      .where(
        and(eq(reviewInsights.organizationId, organizationId), eq(reviewInsights.businessId, businessId)),
      );
  }

  async expiring(now: Date, limit: number): Promise<Array<{ organizationId: string; businessId: string }>> {
    return (
      getExecutor(this.db)
        .select({ organizationId: reviewInsights.organizationId, businessId: reviewInsights.businessId })
        .from(reviewInsights)
        // Expired at `now` itself too, like the domain (`liveContributions`).
        .where(lte(reviewInsights.expiresAt, now))
        .orderBy(asc(reviewInsights.expiresAt))
        .limit(limit)
    );
  }

  async withSource(organizationId: string, source: ReviewSource, limit: number): Promise<string[]> {
    const rows = await getExecutor(this.db)
      .select({ businessId: reviewInsights.businessId })
      .from(reviewInsights)
      .where(
        and(
          eq(reviewInsights.organizationId, organizationId),
          sql`${reviewInsights.sourceStats} ? ${source}`,
        ),
      )
      .orderBy(asc(reviewInsights.businessId))
      .limit(limit);
    return rows.map((r) => r.businessId);
  }
}

@Injectable()
export class DrizzleRatingObservations implements RatingObservationRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async record(businessId: string, observation: RatingObservation, expiresAt: Date | null): Promise<void> {
    const x = getExecutor(this.db);
    const [recent] = await x
      .select({ id: businessRatingObservations.id })
      .from(businessRatingObservations)
      .where(
        and(
          eq(businessRatingObservations.businessId, businessId),
          eq(businessRatingObservations.source, observation.source),
          gt(
            businessRatingObservations.observedAt,
            new Date(observation.observedAt.getTime() - OBSERVATION_DEDUP_MS),
          ),
        ),
      )
      .limit(1);
    if (recent) return;
    await x.insert(businessRatingObservations).values({
      businessId,
      source: observation.source,
      avg: observation.avg,
      count: observation.count,
      observedAt: observation.observedAt,
      expiresAt,
    });
  }

  async list(businessId: string, now: Date): Promise<RatingObservation[]> {
    const rows = await getExecutor(this.db)
      .select()
      .from(businessRatingObservations)
      .where(
        and(
          eq(businessRatingObservations.businessId, businessId),
          or(isNull(businessRatingObservations.expiresAt), gt(businessRatingObservations.expiresAt, now)),
          sql`${businessRatingObservations.observedAt} <= ${now.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(desc(businessRatingObservations.observedAt))
      .limit(200);
    return rows.map((r) => ({ source: r.source, avg: r.avg, count: r.count, observedAt: r.observedAt }));
  }

  async purgeExpired(now: Date): Promise<number> {
    const rows = await getExecutor(this.db)
      .delete(businessRatingObservations)
      .where(lt(businessRatingObservations.expiresAt, now))
      .returning({ id: businessRatingObservations.id });
    return rows.length;
  }
}

@Injectable()
export class DrizzleReviewSourceSettings implements ReviewSourceSettingsRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async list(organizationId: string): Promise<Partial<Record<ReviewSource, ReviewsUsage>>> {
    const rows = await getExecutor(this.db)
      .select({ source: reviewSourceSettings.source, usage: reviewSourceSettings.usage })
      .from(reviewSourceSettings)
      .where(eq(reviewSourceSettings.organizationId, organizationId));
    return Object.fromEntries(rows.map((r) => [r.source, r.usage]));
  }

  async set(
    organizationId: string,
    source: ReviewSource,
    usage: ReviewsUsage,
    userId: string | null,
  ): Promise<void> {
    await getExecutor(this.db)
      .insert(reviewSourceSettings)
      .values({ organizationId, source, usage, updatedBy: userId })
      .onConflictDoUpdate({
        target: [reviewSourceSettings.organizationId, reviewSourceSettings.source],
        set: { usage, updatedBy: userId },
      });
  }
}

/**
 * The golden record and provider references as review sources need them (read-only).
 * DECISION(BF-029): a cross-module read model on business-graph tables, like enrichment's subject reader.
 */
@Injectable()
export class DrizzleReviewSubjectReader implements ReviewSubjectReader {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async tracks(organizationId: string, businessId: string): Promise<boolean> {
    const [row] = await getExecutor(this.db)
      .select({ one: sql`1` })
      .from(orgBusinesses)
      .where(and(eq(orgBusinesses.organizationId, organizationId), eq(orgBusinesses.businessId, businessId)))
      .limit(1);
    return row !== undefined;
  }

  async find(businessId: string): Promise<ReviewSubject | undefined> {
    const x = getExecutor(this.db);
    const [row] = await x
      .select({
        id: businesses.id,
        displayName: businesses.displayName,
        countryCode: businesses.countryCode,
        ratingAvg: businesses.ratingAvg,
        ratingCount: businesses.ratingCount,
        lat: sql<number | null>`ST_Y(${businesses.location}::geometry)`,
        lng: sql<number | null>`ST_X(${businesses.location}::geometry)`,
        categoryLabel: sql<string | null>`(SELECT ${categories.labels}->>'en' FROM ${businessCategories}
          JOIN ${categories} ON ${categories.id} = ${businessCategories.categoryId}
          WHERE ${businessCategories.businessId} = ${businesses.id} AND ${businessCategories.isPrimary} LIMIT 1)`,
      })
      .from(businesses)
      .where(and(eq(businesses.id, businessId), isNull(businesses.mergedIntoId)));
    if (!row) return undefined;
    const sources = await x
      .select({ provider: businessSources.provider, ref: businessSources.providerRef })
      .from(businessSources)
      .where(
        and(
          eq(businessSources.businessId, businessId),
          inArray(businessSources.provider, ['google_places', 'gmaps_scraper']),
        ),
      )
      .orderBy(desc(businessSources.fetchedAt));
    return {
      businessId: row.id,
      displayName: row.displayName,
      location: row.lat !== null && row.lng !== null ? { lat: Number(row.lat), lng: Number(row.lng) } : null,
      categoryLabel: row.categoryLabel,
      googlePlaceId: sources.find((s) => s.provider === 'google_places')?.ref ?? null,
      scraperRefs: sources.filter((s) => s.provider === 'gmaps_scraper').map((s) => s.ref),
      rating:
        row.ratingAvg !== null && row.ratingCount !== null
          ? { avg: row.ratingAvg, count: row.ratingCount }
          : null,
      locale: FRENCH.has(row.countryCode ?? '') ? 'fr' : 'en',
    };
  }
}
