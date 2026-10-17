// Mailboxes (BF-050): the partners' real mailboxes outreach sends from, their daily usage and lifecycle trail.
// Credentials are never stored here: `secret_ref` names the vault entry (security.md §2).

import {
  MAILBOX_PROVIDERS,
  MAILBOX_STATUSES,
  type MailboxHealth,
  type MailboxLastError,
  type MailboxProviderKind,
  type MailboxProviderState,
  type MailboxRamp,
  type MailboxStatus,
  type SendWindow,
} from '@bf/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, orgId, timestamps } from '../columns.ts';
import { citext } from '../types/text.ts';
import { organization, user } from './auth.ts';

export const mailboxes = pgTable(
  'mailboxes',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    /** Null for a shared mailbox (managed with `settings:manage`). */
    ownerUserId: uuid().references(() => user.id, { onDelete: 'set null' }),
    provider: text({ enum: MAILBOX_PROVIDERS }).$type<MailboxProviderKind>().notNull(),
    email: citext().notNull(),
    displayName: text().notNull(),
    status: text({ enum: MAILBOX_STATUSES }).$type<MailboxStatus>().notNull().default('connected'),
    statusReason: text(),
    dailyCap: integer().notNull().default(50),
    ramp: jsonb().$type<MailboxRamp>().notNull(),
    window: jsonb().$type<SendWindow>().notNull(),
    minIntervalSec: integer().notNull().default(90),
    locales: text().array().notNull().default(sql`ARRAY['en']::text[]`),
    signatureMd: text().notNull().default(''),
    replyTo: citext(),
    /** The vault entry holding the credentials (`mailbox:<id>`); null once disconnected. */
    secretRef: text(),
    providerState: jsonb().$type<MailboxProviderState>().notNull().default({}),
    health: jsonb().$type<MailboxHealth>().notNull(),
    lastError: jsonb().$type<MailboxLastError>(),
    /** Round-robin fairness for the selector. */
    lastSelectedAt: timestamp({ withTimezone: true }),
    disconnectedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('uq_mailboxes__org_email').on(table.organizationId, table.email),
    index('ix_mailboxes__org_status').on(table.organizationId, table.status),
    check('ck_mailboxes__caps', sql`${table.dailyCap} > 0 AND ${table.minIntervalSec} >= 30`),
  ],
);

export const mailboxDailyUsage = pgTable(
  'mailbox_daily_usage',
  {
    mailboxId: uuid()
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade' }),
    /** The day in the mailbox timezone. */
    day: date({ mode: 'string' }).notNull(),
    sent: integer().notNull().default(0),
    failed: integer().notNull().default(0),
    bounced: integer().notNull().default(0),
    complaints: integer().notNull().default(0),
    replies: integer().notNull().default(0),
  },
  (table) => [primaryKey({ name: 'pk_mailbox_daily_usage', columns: [table.mailboxId, table.day] })],
);

export const mailboxEvents = pgTable(
  'mailbox_events',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    mailboxId: uuid()
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade' }),
    /** `status_changed`, `settings_changed`, `error`, `health_checked`, `test_sent`, `reconnected`. */
    kind: text().notNull(),
    fromStatus: text({ enum: MAILBOX_STATUSES }).$type<MailboxStatus>(),
    toStatus: text({ enum: MAILBOX_STATUSES }).$type<MailboxStatus>(),
    detail: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    actorUserId: uuid().references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ix_mailbox_events__mailbox_created').on(table.mailboxId, table.createdAt)],
);
