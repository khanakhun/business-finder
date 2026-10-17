// Outcome-trained scoring (BF-059): versioned label definitions and the labelled datasets built from analytics
// facts and score history (the file itself is in object storage; this is its manifest).

import type { MlDataset } from '@bf/contracts';
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
