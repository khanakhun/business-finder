// Outcome-trained scoring (BF-059): versioned label definitions and the labelled datasets built from analytics
// facts and score history (the file itself is in object storage; this is its manifest).

import type {
  ML_TRAINING_RUN_STATUSES,
  MlDataset,
  MlMetrics,
  MlModelKind,
  MlModelStatus,
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
