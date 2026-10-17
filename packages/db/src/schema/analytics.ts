// Analytics (BF-058): an append-only fact per business event, with the dimensions as they were at the event (the tier
// when the email went out, not today's), partitioned by month on `occurred_at` (the migration declares the
// partitioning; Drizzle only knows the columns). `source_key` names the source (`email_sent:<message id>`) so live
// ingestion and the backfill write a fact once. No personal data: ids of businesses, sites, messages — never an
// address, a name or an IP.

import { newId } from '@bf/contracts';
import {
  bigint,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { ltree } from '../types/text.ts';

const tz = () => timestamp({ withTimezone: true });

export const analyticsFacts = pgTable(
  'analytics_facts',
  {
    id: uuid()
      .notNull()
      .$defaultFn(() => newId()),
    organizationId: uuid().notNull(),
    occurredAt: tz().notNull(),
    eventType: text().notNull(),
    sourceKey: text().notNull(),
    businessId: uuid(),
    siteId: uuid(),
    jobId: uuid(),
    messageId: uuid(),
    enrollmentId: uuid(),
    leadId: uuid(),
    // Hot dimensions, snapshotted at the event.
    categoryPath: ltree(),
    areaId: uuid(),
    country: text(),
    offer: text(),
    scoreTier: text(),
    scoreValue: smallint(),
    profileVersion: integer(),
    engine: text(),
    templateId: uuid(),
    templateVersion: integer(),
    variantId: text(),
    mailboxId: uuid(),
    locale: text(),
    creatorId: uuid(),
    /** What happened: a reply class, a pipeline status, a job status, a lead kind, a channel, a cost category. */
    outcome: text(),
    /** Other dimensions (a cost's feature, a site page). */
    dims: jsonb().$type<Record<string, string | number | boolean | null>>().notNull().default({}),
    // Measures.
    costUsd: numeric({ precision: 14, scale: 6, mode: 'number' }),
    durationMs: integer(),
    qualityScore: doublePrecision(),
    count: integer().notNull().default(1),
    ingestedAt: tz().notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'analytics_facts_pkey', columns: [table.id, table.occurredAt] }),
    uniqueIndex('uq_analytics_facts__source').on(table.organizationId, table.sourceKey, table.occurredAt),
    index('ix_analytics_facts__org_type_time').on(table.organizationId, table.eventType, table.occurredAt),
    index('ix_analytics_facts__org_business').on(table.organizationId, table.businessId, table.occurredAt),
    index('ix_analytics_facts__category').using('gist', table.categoryPath),
  ],
);

/** How far each ingestion source has been read (cost ledgers are polled, events are pushed). */
export const analyticsWatermarks = pgTable('analytics_watermarks', {
  source: text().primaryKey(),
  watermark: tz().notNull(),
  updatedAt: tz().notNull().defaultNow(),
});

/**
 * Daily rollup of the facts (BF-058) for the dashboards' trends: additive measures per day and the dimensions the
 * overview splits by (empty string for none). Refreshed every 15 minutes for the days touched since the last run.
 * Distinct counts (businesses contacted…) are not additive and stay on the facts.
 */
export const analyticsDaily = pgTable(
  'analytics_daily',
  {
    organizationId: uuid().notNull(),
    day: date({ mode: 'string' }).notNull(),
    eventType: text().notNull(),
    outcome: text().notNull().default(''),
    category: text().notNull().default(''),
    scoreTier: text().notNull().default(''),
    engine: text().notNull().default(''),
    offer: text().notNull().default(''),
    facts: integer().notNull(),
    units: bigint({ mode: 'number' }).notNull(),
    costUsd: numeric({ precision: 16, scale: 6, mode: 'number' }).notNull().default(0),
    durationMsSum: bigint({ mode: 'number' }).notNull().default(0),
    qualitySum: doublePrecision().notNull().default(0),
    qualityN: integer().notNull().default(0),
  },
  (table) => [
    primaryKey({
      name: 'analytics_daily_pkey',
      columns: [
        table.organizationId,
        table.day,
        table.eventType,
        table.outcome,
        table.category,
        table.scoreTier,
        table.engine,
        table.offer,
      ],
    }),
  ],
);
