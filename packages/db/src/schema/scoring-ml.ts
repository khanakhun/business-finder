// Outcome-trained scoring (BF-059): versioned label definitions and the labelled datasets built from analytics
// facts and score history (the file itself is in object storage; this is its manifest).

import type {
  ML_TRAINING_RUN_STATUSES,
  MlDataset,
  MlMetrics,
  MlModelKind,
  MlModelStatus,
  ScoreContribution,
  ScoreReason,
} from '@bf/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
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
import { id, orgId } from '../columns.ts';
import { organization, user } from './auth.ts';

const tz = () => timestamp({ withTimezone: true });

export const mlLabelDefinitions = pgTable('ml_label_definitions', {
  version: integer().primaryKey(),
  definition: jsonb().$type<Record<string, unknown>>().notNull(),
  createdAt: tz().notNull().defaultNow(),
});

export const mlDatasets = pgTable(
  'ml_datasets',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    offer: text().notNull(),
    labelVersion: integer()
      .notNull()
      .references(() => mlLabelDefinitions.version),
    windowFrom: tz().notNull(),
    windowTo: tz().notNull(),
    counts: jsonb().$type<MlDataset['counts']>().notNull(),
    features: jsonb().$type<MlDataset['features']>().notNull(),
    storageKey: text().notNull(),
    sha256: text().notNull(),
    createdBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    createdAt: tz().notNull().defaultNow(),
  },
  (table) => [index('ix_ml_datasets__org_offer').on(table.organizationId, table.offer, table.createdAt)],
);

/**
 * Trained models (BF-059 registry): immutable once trained — only the status and the promotion stamp change (a
 * trigger refuses the rest). Artifacts are in the artifacts bucket under `artifact_keys`, checked against
 * `artifact_hashes` before a model is loaded.
 */
export const scoringModels = pgTable(
  'scoring_models',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    offer: text().notNull(),
    version: integer().notNull(),
    kind: text().$type<MlModelKind>().notNull(),
    status: text().$type<MlModelStatus>().notNull().default('trained'),
    datasetId: uuid()
      .notNull()
      .references(() => mlDatasets.id),
    labelVersion: integer().notNull(),
    artifactKeys: jsonb()
      .$type<Record<'model' | 'preprocessing' | 'modelCardJson' | 'modelCardMd', string>>()
      .notNull(),
    artifactHashes: jsonb()
      .$type<Record<'model' | 'preprocessing' | 'modelCardJson' | 'modelCardMd', string>>()
      .notNull(),
    modelCard: jsonb().$type<Record<string, unknown>>().notNull(),
    metrics: jsonb().$type<MlMetrics>().notNull(),
    baselineMetrics: jsonb().$type<MlMetrics>().notNull(),
    spearman: doublePrecision(),
    warnings: jsonb().$type<string[]>().notNull().default([]),
    trainedBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    trainedAt: tz().notNull().defaultNow(),
    promotedBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    promotedAt: tz(),
  },
  (table) => [
    uniqueIndex('uq_scoring_models__org_offer_version').on(table.organizationId, table.offer, table.version),
    check(
      'ck_scoring_models__status',
      sql`${table.status} IN ('trained', 'shadow', 'active', 'retired', 'rejected')`,
    ),
  ],
);

export const mlTrainingRuns = pgTable(
  'ml_training_runs',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    datasetId: uuid()
      .notNull()
      .references(() => mlDatasets.id, { onDelete: 'cascade' }),
    status: text().$type<(typeof ML_TRAINING_RUN_STATUSES)[number]>().notNull().default('queued'),
    considerGbm: boolean().notNull().default(true),
    error: text(),
    modelId: uuid().references(() => scoringModels.id, { onDelete: 'set null' }),
    createdBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    createdAt: tz().notNull().defaultNow(),
    finishedAt: tz(),
  },
  (table) => [index('ix_ml_training_runs__org_created').on(table.organizationId, table.createdAt)],
);

/** The model a profile runs in shadow for a workspace (BF-059): scored alongside, affecting nothing. */
export const scoringShadowAssignments = pgTable(
  'scoring_shadow_assignments',
  {
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    profileId: uuid().notNull(),
    modelId: uuid()
      .notNull()
      .references(() => scoringModels.id, { onDelete: 'cascade' }),
    startedBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    startedAt: tz().notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.profileId] })],
);

/**
 * Shadow scores (BF-059), append-only like `business_score_history`: one row per new feature vector and model, so
 * the prospective comparison can read the shadow score a business had when it was contacted.
 */
export const businessScoreShadows = pgTable(
  'business_score_shadows',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    businessId: uuid().notNull(),
    profileId: uuid().notNull(),
    modelId: uuid()
      .notNull()
      .references(() => scoringModels.id, { onDelete: 'cascade' }),
    probability: doublePrecision().notNull(),
    score: smallint().notNull(),
    tier: text().notNull(),
    contributions: jsonb().$type<ScoreContribution[]>().notNull(),
    reasons: jsonb().$type<ScoreReason[]>().notNull(),
    factsHash: text().notNull(),
    computedAt: tz().notNull(),
  },
  (table) => [
    index('ix_business_score_shadows__latest').on(
      table.organizationId,
      table.businessId,
      table.profileId,
      table.computedAt.desc(),
    ),
    index('ix_business_score_shadows__model').on(table.modelId, table.computedAt),
  ],
);
