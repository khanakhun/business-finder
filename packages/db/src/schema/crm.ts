// CRM context (BF-014, minimal): a workspace's relationship with a business. BF-022/BF-024 extend it.

import { ADDED_VIA, type AddedVia, PIPELINE_STATUSES, type PipelineStatus } from '@bf/contracts';
import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps } from '../columns.ts';
import { organization } from './auth.ts';
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
    check(
      'ck_org_businesses__pipeline_status',
      sql`${table.pipelineStatus} IN (${inList(PIPELINE_STATUSES)})`,
    ),
    check('ck_org_businesses__added_via', sql`${table.addedVia} IN (${inList(ADDED_VIA)})`),
  ],
);
