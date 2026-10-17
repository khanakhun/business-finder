// Replies (BF-054): only messages of outreach conversations are stored (the privacy filter runs before this table).
// Bodies are sanitized text and HTML (≤ 100 KB); attachments are metadata only. The raw message is not kept by
// default. Per-mailbox sync state (cursor, health) drives polling.

import type { InboundKind, Triage, TriageClass } from '@bf/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, orgId, timestamps } from '../columns.ts';
import { organization, user } from './auth.ts';
import { mailboxes } from './mailboxes.ts';
import { emailThreads, outboundMessages } from './outbound.ts';

const tz = () => timestamp({ withTimezone: true });

export const inboundMessages = pgTable(
  'inbound_messages',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    mailboxId: uuid()
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade' }),
    threadId: uuid()
      .notNull()
      .references(() => emailThreads.id, { onDelete: 'cascade' }),
    outboundMessageId: uuid().references(() => outboundMessages.id, { onDelete: 'set null' }),
    providerMessageId: text().notNull(),
    rfc822MessageId: text(),
    inReplyTo: text(),
    references: text().array().notNull().default(sql`ARRAY[]::text[]`),
    fromEmail: text(),
    fromName: text(),
    to: text().array().notNull().default(sql`ARRAY[]::text[]`),
    cc: text().array().notNull().default(sql`ARRAY[]::text[]`),
    subject: text().notNull(),
    receivedAt: tz().notNull(),
    bodyText: text().notNull(),
    bodyHtmlSanitized: text(),
    hasRemoteImages: boolean().notNull().default(false),
    snippet: text().notNull(),
    attachments: jsonb()
      .$type<{ filename: string | null; contentType: string; size: number }[]>()
      .notNull()
      .default([]),
    kind: text().$type<InboundKind>().notNull(),
    dsn: jsonb().$type<{
      action: string;
      status: string | null;
      permanent: boolean;
      recipient: string | null;
      diagnostic: string | null;
    }>(),
    autoReplyUntil: text(),
    unsubscribeDetected: boolean().notNull().default(false),
    triage: jsonb().$type<Triage>(),
    triageStatus: text()
      .$type<'pending' | 'done' | 'needs_human' | 'corrected'>()
      .notNull()
      .default('pending'),
    correctedClass: text().$type<TriageClass>(),
    correctedBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    correctedAt: tz(),
    status: text().$type<'new' | 'read' | 'handled' | 'snoozed'>().notNull().default('new'),
    assignedTo: uuid().references(() => user.id, { onDelete: 'set null' }),
    snoozedUntil: tz(),
    rawStorageKey: text(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('uq_inbound_messages__mailbox_provider').on(table.mailboxId, table.providerMessageId),
    index('ix_inbound_messages__org_thread').on(table.organizationId, table.threadId, table.receivedAt),
    index('ix_inbound_messages__org_status').on(table.organizationId, table.status, table.receivedAt),
    index('ix_inbound_messages__from').on(table.organizationId, table.fromEmail),
  ],
);

/** Per-mailbox sync (BF-054): the provider cursor, when to poll next, and health for BF-053/BF-056. */
export const mailboxSyncState = pgTable('mailbox_sync_state', {
  mailboxId: uuid()
    .primaryKey()
    .references(() => mailboxes.id, { onDelete: 'cascade' }),
  organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
  cursor: jsonb().$type<Record<string, unknown>>(),
  nextPollAt: tz().notNull().defaultNow(),
  lastSuccessAt: tz(),
  lastErrorAt: tz(),
  lastError: text(),
  consecutiveErrors: integer().notNull().default(0),
  /** Seconds between the newest ingested message's arrival and its ingestion (last sync). */
  lagSeconds: integer(),
  ingested: integer().notNull().default(0),
  ignored: integer().notNull().default(0),
  ...timestamps(),
});
