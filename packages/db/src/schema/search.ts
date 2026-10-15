// Search context (BF-022): saved searches and hand-curated lists, both workspace-scoped.

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, orgId, timestamps } from '../columns.ts';
import { organization, user } from './auth.ts';
import { businesses } from './business-graph.ts';

const tz = () => timestamp({ withTimezone: true });

/** A named listing query: the prompt and intent it came from (if any) plus the filters and sort it runs. */
export const savedSearches = pgTable(
  'saved_searches',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    createdBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    name: text().notNull(),
    prompt: text(),
    /** The `SearchIntent` (BF-021) the filters were derived from, as the user last edited it. */
    intent: jsonb().$type<Record<string, unknown>>(),
    /** `BusinessSearchFilters` (contracts) without the cursor. */
    filters: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Sort expression (`-score`, `relevance`…). */
    sort: text().notNull().default('relevance'),
    visibility: text().$type<'private' | 'workspace'>().notNull().default('private'),
    notifyNew: boolean().notNull().default(false),
    /** When the search was last opened: "new matches since" counts businesses tracked after it. */
    lastRunAt: tz(),
    ...timestamps(),
  },
  (table) => [
    index('idx_saved_searches__organization_id_created_at').on(
      table.organizationId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    check('ck_saved_searches__visibility', sql`${table.visibility} IN ('private', 'workspace')`),
    check('ck_saved_searches__name', sql`length(${table.name}) BETWEEN 1 AND 120`),
  ],
);

export const lists = pgTable(
  'lists',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    description: text(),
    createdBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('uq_lists__organization_id_name').on(table.organizationId, table.name),
    index('idx_lists__organization_id_created_at').on(
      table.organizationId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    check('ck_lists__name', sql`length(${table.name}) BETWEEN 1 AND 120`),
  ],
);

export const listItems = pgTable(
  'list_items',
  {
    listId: uuid()
      .notNull()
      .references(() => lists.id, { onDelete: 'cascade' }),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    addedBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    addedAt: tz().notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.listId, table.businessId] }),
    index('idx_list_items__list_id_added_at').on(table.listId, table.addedAt.desc(), table.businessId.desc()),
    index('idx_list_items__business_id').on(table.businessId),
  ],
);
