// CRM context (BF-014, minimal): a workspace's relationship with a business. BF-022/BF-024 extend it.

import {
  ADDED_VIA,
  type AddedVia,
  PIPELINE_STATUSES,
  type PipelineStatus,
  SCORE_TIERS,
  type ScoreTier,
} from '@bf/contracts';

const CRM_TASK_TYPES = ['call', 'email', 'visit', 'follow_up', 'other'] as const;
const CRM_TASK_STATUSES = ['open', 'done', 'cancelled'] as const;

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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
import { id, orgId, timestamps } from '../columns.ts';
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
    // CRM (BF-024): pipeline history, reasons and counters kept by the crm module.
    statusChangedAt: timestamp({ withTimezone: true }),
    disqualifiedReason: text(),
    lostReason: text(),
    doNotContactReason: text(),
    notesCount: integer().notNull().default(0),
    openTasksCount: integer().notNull().default(0),
    nextTaskDueAt: timestamp({ withTimezone: true }),
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

const tz = () => timestamp({ withTimezone: true });

/** Notes about a business (markdown, sanitized when rendered). Soft-deleted. */
export const notes = pgTable(
  'notes',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    authorId: uuid().references(() => user.id, { onDelete: 'set null' }),
    bodyMarkdown: text().notNull(),
    pinned: boolean().notNull().default(false),
    deletedAt: tz(),
    ...timestamps(),
  },
  (table) => [
    index('idx_notes__organization_id_business_id').on(
      table.organizationId,
      table.businessId,
      table.createdAt.desc(),
    ),
    check('ck_notes__body', sql`length(${table.bodyMarkdown}) BETWEEN 1 AND 20000`),
  ],
);

export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    assigneeId: uuid().references(() => user.id, { onDelete: 'set null' }),
    createdBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    type: text().$type<(typeof CRM_TASK_TYPES)[number]>().notNull(),
    title: text().notNull(),
    dueAt: tz(),
    status: text().$type<(typeof CRM_TASK_STATUSES)[number]>().notNull().default('open'),
    completedAt: tz(),
    ...timestamps(),
  },
  (table) => [
    index('idx_tasks__organization_id_assignee_id_status_due_at').on(
      table.organizationId,
      table.assigneeId,
      table.status,
      table.dueAt,
    ),
    index('idx_tasks__organization_id_business_id').on(table.organizationId, table.businessId),
    check('ck_tasks__type', sql`${table.type} IN (${inList(CRM_TASK_TYPES)})`),
    check('ck_tasks__status', sql`${table.status} IN (${inList(CRM_TASK_STATUSES)})`),
    check('ck_tasks__title', sql`length(${table.title}) BETWEEN 1 AND 200`),
  ],
);

/** The business timeline, written by the activity subscriber from domain events (append-only). */
export const activities = pgTable(
  'activities',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    actor: jsonb().$type<{ type: string; id: string | null }>().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: tz().notNull(),
    /** The event it came from: re-delivered events never duplicate an activity. */
    sourceEventId: uuid(),
  },
  (table) => [
    index('idx_activities__organization_id_business_id_occurred_at').on(
      table.organizationId,
      table.businessId,
      table.occurredAt.desc(),
      table.id.desc(),
    ),
    uniqueIndex('uq_activities__source_event_id_organization_id').on(
      table.sourceEventId,
      table.organizationId,
    ),
  ],
);
