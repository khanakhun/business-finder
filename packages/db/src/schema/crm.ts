// CRM context (BF-014, minimal): a workspace's relationship with a business. BF-022/BF-024 extend it.

import {
  ADDED_VIA,
  type AddedVia,
  PIPELINE_STATUSES,
  type PipelineStatus,
  SCORE_TIERS,
  type ScoreTier,
} from '@bf/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamps } from '../columns.ts';
import { organization, user } from './auth.ts';
import { businesses } from './business-graph.ts';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export const orgBusinesses = pgTable(
  'org_businesses',
  {
    organizationId: uuid()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    pipelineStatus: text().$type<PipelineStatus>().notNull().default('new'),
    addedVia: text().$type<AddedVia>().notNull(),
    /** What added it (discovery run id, search id, import id). */
    addedRef: text(),
    doNotContact: boolean().notNull().default(false),
    // Denormalized sort/filter keys for the listing (BF-022); scoring (BF-031) and the CRM (BF-024) keep them.
    score: smallint(),
    tier: text().$type<ScoreTier>(),
    /** The scoring profile behind `score` (table arrives with BF-031). */
    scoreProfileId: uuid(),
    lastActivityAt: timestamp({ withTimezone: true }),
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    ownerUserId: uuid().references(() => user.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.businessId] }),
    index('idx_org_businesses__organization_id_pipeline_status').on(
      table.organizationId,
      table.pipelineStatus,
    ),
    // Default listing order (most recently tracked first, keyset on created_at + business_id).
    index('idx_org_businesses__organization_id_created_at').on(
      table.organizationId,
      table.createdAt.desc(),
      table.businessId.desc(),
    ),
    index('idx_org_businesses__business_id').on(table.businessId),
    // Created CONCURRENTLY in standalone migrations (BF-022).
    index('idx_org_businesses__organization_id_score').on(
      table.organizationId,
      table.score.desc().nullsLast(),
      // Same direction as the score: `-score` (the listing's id tie-break follows the sort) walks it in order.
      table.businessId.desc(),
    ),
    index('idx_org_businesses__tags').using('gin', table.tags),
    check(
      'ck_org_businesses__pipeline_status',
      sql`${table.pipelineStatus} IN (${inList(PIPELINE_STATUSES)})`,
    ),
    check('ck_org_businesses__added_via', sql`${table.addedVia} IN (${inList(ADDED_VIA)})`),
    check('ck_org_businesses__score', sql`${table.score} BETWEEN 0 AND 100`),
    check('ck_org_businesses__tier', sql`${table.tier} IN (${inList(SCORE_TIERS)})`),
  ],
);
