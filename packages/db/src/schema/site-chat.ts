// Chat-based site editing (BF-047): a site's chat threads, their messages, and the change proposals the edit agent
// makes (operations, diff, validation, facts to confirm). Kept 180 days (retention job), scoped to the workspace.

import {
  type PendingFact,
  PROPOSAL_STATUSES,
  type ProposalIssue,
  type ProposalStatus,
  type SiteChatContext,
  type SiteChatPart,
} from '@bf/contracts';
import { doublePrecision, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id, orgId, timestamps } from '../columns.ts';
import { organization, user } from './auth.ts';
import { sites, siteVersions } from './sites.ts';

export const siteChatThreads = pgTable(
  'site_chat_threads',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    siteId: uuid()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    createdBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    title: text().notNull(),
    ...timestamps(),
  },
  (table) => [index('site_chat_threads_site_idx').on(table.organizationId, table.siteId, table.updatedAt)],
);

export const siteChatMessages = pgTable(
  'site_chat_messages',
  {
    id: id(),
    threadId: uuid()
      .notNull()
      .references(() => siteChatThreads.id, { onDelete: 'cascade' }),
    role: text().$type<'user' | 'assistant'>().notNull(),
    parts: jsonb().$type<SiteChatPart[]>().notNull(),
    context: jsonb().$type<SiteChatContext>().notNull(),
    costUsd: doublePrecision().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('site_chat_messages_thread_idx').on(table.threadId, table.createdAt)],
);

export const siteChangeProposals = pgTable(
  'site_change_proposals',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    threadId: uuid()
      .notNull()
      .references(() => siteChatThreads.id, { onDelete: 'cascade' }),
    messageId: uuid().references(() => siteChatMessages.id, { onDelete: 'set null' }),
    siteId: uuid()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    baseVersionId: uuid()
      .notNull()
      .references(() => siteVersions.id, { onDelete: 'cascade' }),
    operations: jsonb().$type<Record<string, unknown>[]>().notNull(),
    summary: text().notNull(),
    diff: jsonb().$type<Record<string, unknown>>().notNull(),
    issues: jsonb().$type<ProposalIssue[]>().notNull(),
    factsToAssert: jsonb().$type<PendingFact[]>().notNull(),
    status: text({ enum: PROPOSAL_STATUSES }).$type<ProposalStatus>().notNull().default('proposed'),
    statusReason: text(),
    appliedVersionId: uuid().references(() => siteVersions.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (table) => [
    index('site_change_proposals_thread_idx').on(table.threadId, table.createdAt),
    index('site_change_proposals_site_idx').on(table.organizationId, table.siteId, table.status),
  ],
);
