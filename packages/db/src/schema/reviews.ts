// Review mining (BF-029): aggregated, anonymous insights per workspace and business, rating observations over time,
// and which review sources each workspace allows. No review text and no reviewer identity lives here (security.md §7).

import {
  type EvidenceSnippet,
  type PainSignalTag,
  RATING_OBSERVATION_SOURCES,
  RATING_TRENDS,
  type RatingObservationSource,
  type RatingTrend,
  REVIEW_SOURCES,
  REVIEWS_USAGES,
  type ReviewSource,
  type ReviewsUsage,
} from '@bf/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from '../columns.ts';
import { organization, user } from './auth.ts';
import { businesses } from './business-graph.ts';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));
const tz = () => timestamp({ withTimezone: true });

/**
 * What one source contributed to a business's insights: sums the totals are rebuilt from, so a source can be
 * refreshed or expire on its own (the other sources' part stays).
 */
export interface ReviewSourceStats {
  readonly sampleSize: number;
  readonly painCounts: Partial<Record<PainSignalTag, number>>;
  readonly sentimentSum: number;
  /** Reviews whose source says whether the owner replied (or that mention a reply). */
  readonly ownerResponses: number;
  readonly ownerResponseKnown: number;
  readonly evidence: Partial<Record<PainSignalTag, EvidenceSnippet[]>>;
  readonly computedAt: string;
  readonly expiresAt: string | null;
  readonly model: string;
  readonly promptVersion: number;
}

/** Insights per workspace and business (gates and pasted reviews are the workspace's own). */
export const reviewInsights = pgTable(
  'review_insights',
  {
    organizationId: uuid()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    computedAt: tz().notNull(),
    sources: text().array().$type<ReviewSource[]>().notNull(),
    sampleSize: integer().notNull(),
    painCounts: jsonb().$type<Partial<Record<PainSignalTag, number>>>().notNull(),
    painShare: jsonb().$type<Partial<Record<PainSignalTag, number>>>().notNull(),
    sentimentAvg: real(),
    ownerResponseRate: real(),
    ratingSnapshot: jsonb().$type<{ avg: number; count: number; observedAt: string }>(),
    ratingTrend: text().$type<RatingTrend>().notNull().default('unknown'),
    evidence: jsonb().$type<Partial<Record<PainSignalTag, EvidenceSnippet[]>>>().notNull(),
    sourceStats: jsonb().$type<Partial<Record<ReviewSource, ReviewSourceStats>>>().notNull(),
    model: text().notNull(),
    promptVersion: integer().notNull(),
    /** The earliest expiry among the sources' contributions (null when none expires). */
    expiresAt: tz(),
    ...timestamps(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.businessId] }),
    index('idx_review_insights__business_id').on(table.businessId),
    index('idx_review_insights__expires_at').on(table.expiresAt).where(sql`${table.expiresAt} IS NOT NULL`),
    check('ck_review_insights__rating_trend', sql`${table.ratingTrend} IN (${inList(RATING_TRENDS)})`),
    check('ck_review_insights__sample_size', sql`${table.sampleSize} >= 0`),
    check('ck_review_insights__sentiment_avg', sql`${table.sentimentAvg} BETWEEN -1 AND 1`),
    check('ck_review_insights__owner_response_rate', sql`${table.ownerResponseRate} BETWEEN 0 AND 1`),
  ],
);

/** Ratings seen over time (trend), kept within the source's retention. Public provider facts: not per workspace. */
export const businessRatingObservations = pgTable(
  'business_rating_observations',
  {
    id: id(),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    source: text().$type<RatingObservationSource>().notNull(),
    avg: real().notNull(),
    count: integer().notNull(),
    observedAt: tz().notNull(),
    expiresAt: tz(),
  },
  (table) => [
    index('idx_business_rating_observations__business_id_observed_at').on(
      table.businessId,
      table.observedAt.desc(),
    ),
    index('idx_business_rating_observations__expires_at')
      .on(table.expiresAt)
      .where(sql`${table.expiresAt} IS NOT NULL`),
    check(
      'ck_business_rating_observations__source',
      sql`${table.source} IN (${inList(RATING_OBSERVATION_SOURCES)})`,
    ),
    check('ck_business_rating_observations__avg', sql`${table.avg} BETWEEN 0 AND 5`),
    check('ck_business_rating_observations__count', sql`${table.count} >= 0`),
  ],
);

/**
 * What a workspace allows per review source (absent row = the source's default). Google is enabled by its owner
 * acknowledgement in the audit log, not here.
 */
export const reviewSourceSettings = pgTable(
  'review_source_settings',
  {
    organizationId: uuid()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    source: text().$type<ReviewSource>().notNull(),
    usage: text().$type<ReviewsUsage>().notNull(),
    updatedBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.source] }),
    check('ck_review_source_settings__source', sql`${table.source} IN (${inList(REVIEW_SOURCES)})`),
    check('ck_review_source_settings__usage', sql`${table.usage} IN (${inList(REVIEWS_USAGES)})`),
  ],
);
