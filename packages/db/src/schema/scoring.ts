// Scoring (BF-031): offer profiles and their immutable versions, the current score of each business per workspace
// and profile (with the feature snapshot it was computed from), and the append-only score history (trend, and the
// training data of the outcome model, BF-059).

import {
  type FeatureVector,
  OFFERS,
  type Offer,
  SCORE_TIERS,
  type ScoreContribution,
  type ScoreReason,
  type ScoreResult,
  type ScoreTier,
  type ScoringProfileConfig,
} from '@bf/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from '../columns.ts';
import { organization, user } from './auth.ts';
import { businesses } from './business-graph.ts';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));
const tz = () => timestamp({ withTimezone: true });

/** A profile: built-in (no workspace, read-only) or a workspace's own. Its versions hold the config. */
export const scoringProfiles = pgTable(
  'scoring_profiles',
  {
    id: id(),
    organizationId: uuid().references(() => organization.id, { onDelete: 'cascade' }),
    offer: text().$type<Offer>().notNull(),
    name: text().notNull(),
    builtin: boolean().notNull().default(false),
    /** The version scores are computed with (null until one is activated). */
    activeVersion: integer(),
    createdBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (table) => [
    index('idx_scoring_profiles__organization_id').on(table.organizationId),
    // One built-in profile per offer.
    uniqueIndex('uq_scoring_profiles__builtin_offer').on(table.offer).where(sql`${table.builtin}`),
    check('ck_scoring_profiles__offer', sql`${table.offer} IN (${inList(OFFERS)})`),
    check('ck_scoring_profiles__builtin', sql`${table.builtin} = (${table.organizationId} IS NULL)`),
    check('ck_scoring_profiles__active_version', sql`${table.activeVersion} >= 1`),
  ],
);

/** Immutable versions of a profile (an UPDATE is refused by a trigger): scores name the version they used. */
export const scoringProfileVersions = pgTable(
  'scoring_profile_versions',
  {
    profileId: uuid()
      .notNull()
      .references(() => scoringProfiles.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    config: jsonb().$type<ScoringProfileConfig>().notNull(),
    createdBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    createdAt: tz().notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.profileId, table.version] }),
    check('ck_scoring_profile_versions__version', sql`${table.version} >= 1`),
  ],
);

const scoreColumns = () => ({
  organizationId: uuid().notNull(),
  businessId: uuid()
    .notNull()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  profileId: uuid().notNull(),
  profileVersion: integer().notNull(),
  score: smallint().notNull(),
  tier: text().$type<ScoreTier>().notNull(),
  contributions: jsonb().$type<ScoreContribution[]>().notNull(),
  reasons: jsonb().$type<ScoreReason[]>().notNull(),
  gated: jsonb().$type<ScoreResult['gated']>(),
  /** The feature vector the score was computed from (never recomputed: BF-059 trains on it). */
  features: jsonb().$type<FeatureVector>().notNull(),
  /** The features' semantics the vector was computed with (FEATURE_SET_VERSION). */
  featureSetVersion: integer().notNull(),
  /** sha256 of the feature vector: an unchanged vector under the same versions is not written again. */
  factsHash: text().notNull(),
  computedAt: tz().notNull(),
});

/** The current score of a business per workspace and profile. */
export const businessScores = pgTable('business_scores', scoreColumns(), (table) => [
  primaryKey({
    name: 'business_scores_pkey',
    columns: [table.organizationId, table.businessId, table.profileId],
  }),
  index('idx_business_scores__organization_id_profile_id_score').on(
    table.organizationId,
    table.profileId,
    table.score.desc(),
  ),
  index('idx_business_scores__business_id').on(table.businessId),
  index('idx_business_scores__profile_id').on(table.profileId),
  foreignKey({
    name: 'fk_business_scores__organization_id',
    columns: [table.organizationId],
    foreignColumns: [organization.id],
  }).onDelete('cascade'),
  foreignKey({
    name: 'fk_business_scores__profile_version',
    columns: [table.profileId, table.profileVersion],
    foreignColumns: [scoringProfileVersions.profileId, scoringProfileVersions.version],
  }).onDelete('no action'),
  check('ck_business_scores__score', sql`${table.score} BETWEEN 0 AND 100`),
  check('ck_business_scores__tier', sql`${table.tier} IN (${inList(SCORE_TIERS)})`),
]);

/**
 * Every score ever written (append-only: an UPDATE is refused by a trigger). A profile version with history cannot
 * be deleted (`no action`): BF-059 trains on it; archive profiles instead. Deleting a workspace or a business still
 * removes its rows (retention).
 */
export const businessScoreHistory = pgTable(
  'business_score_history',
  { id: id(), ...scoreColumns() },
  (table) => [
    index('idx_business_score_history__org_business_profile_computed_at').on(
      table.organizationId,
      table.businessId,
      table.profileId,
      table.computedAt.desc(),
    ),
    index('idx_business_score_history__business_id').on(table.businessId),
    index('idx_business_score_history__profile_id').on(table.profileId),
    foreignKey({
      name: 'fk_business_score_history__organization_id',
      columns: [table.organizationId],
      foreignColumns: [organization.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_business_score_history__profile_version',
      columns: [table.profileId, table.profileVersion],
      foreignColumns: [scoringProfileVersions.profileId, scoringProfileVersions.version],
    }).onDelete('no action'),
    check('ck_business_score_history__score', sql`${table.score} BETWEEN 0 AND 100`),
    check('ck_business_score_history__tier', sql`${table.tier} IN (${inList(SCORE_TIERS)})`),
  ],
);

/**
 * A workspace's scoring choices (BF-031): its primary profile fills `org_businesses.score/tier` (listing sorts,
 * filters and facets). No row = the built-in `new_website` profile.
 */
export const scoringWorkspaceSettings = pgTable('scoring_workspace_settings', {
  organizationId: uuid()
    .primaryKey()
    .references(() => organization.id, { onDelete: 'cascade' }),
  primaryProfileId: uuid()
    .notNull()
    .references(() => scoringProfiles.id, { onDelete: 'restrict' }),
  updatedBy: uuid().references(() => user.id, { onDelete: 'set null' }),
  ...timestamps(),
});
