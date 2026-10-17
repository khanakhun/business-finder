// The outbound pipeline (BF-052): threads, messages and manual contact logs. A message cannot be queued (or reach any
// later state) without the enqueue-stage compliance decision, and cannot be `sent` without the send-stage one: both
// are enforced by check constraints, not only by the code. Bodies are kept 24 months (retention, BF-055).

import type {
  EmailLocale,
  EmailPurpose,
  ManualContactChannel,
  Offer,
  OutboundError,
  OutboundStatus,
} from '@bf/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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
import { businessContacts, businesses } from './business-graph.ts';
import { complianceDecisions } from './compliance.ts';
import { emailDrafts } from './drafting.ts';
import { mailboxes } from './mailboxes.ts';

const tz = () => timestamp({ withTimezone: true });

export const emailThreads = pgTable(
  'email_threads',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    contactId: uuid().references(() => businessContacts.id, { onDelete: 'set null' }),
    mailboxId: uuid().references(() => mailboxes.id, { onDelete: 'set null' }),
    subjectRoot: text().notNull(),
    providerThreadId: text(),
    /** RFC 822 Message-ID of the first message (follow-ups reference it). */
    rootMessageId: text().notNull(),
    status: text().$type<'open' | 'replied' | 'closed'>().notNull().default('open'),
    lastMessageAt: tz().notNull().defaultNow(),
    // BF-054: the inbox's view of the thread.
    lastInboundAt: tz(),
    unreadCount: integer().notNull().default(0),
    latestTriageClass: text(),
    ...timestamps(),
  },
  (table) => [
    index('ix_email_threads__org_business').on(table.organizationId, table.businessId, table.lastMessageAt),
    index('ix_email_threads__root_message').on(table.rootMessageId),
  ],
);

/** States that exist only after the enqueue decision. */
const DECIDED = `'queued','sending','sent','failed','blocked','bounced','replied'`;

export const outboundMessages = pgTable(
  'outbound_messages',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    contactId: uuid().references(() => businessContacts.id, { onDelete: 'set null' }),
    threadId: uuid()
      .notNull()
      .references(() => emailThreads.id, { onDelete: 'cascade' }),
    mailboxId: uuid().references(() => mailboxes.id, { onDelete: 'set null' }),
    draftId: uuid().references(() => emailDrafts.id, { onDelete: 'set null' }),
    sequenceEnrollmentId: uuid(),
    sequenceStep: integer(),
    bulkRunId: uuid().references(() => outreachBulkRuns.id, { onDelete: 'set null' }),
    // Content
    purpose: text().$type<EmailPurpose>().notNull(),
    offer: text().$type<Offer>().notNull(),
    locale: text().$type<EmailLocale>().notNull(),
    toEmail: text(),
    subject: text().notNull(),
    bodyText: text().notNull(),
    bodyHtml: text().notNull(),
    headers: jsonb().$type<Record<string, string>>().notNull().default({}),
    // Tokens
    unsubscribeTokenId: uuid(),
    outreachToken: text(),
    // Compliance
    enqueueDecisionId: uuid().references(() => complianceDecisions.id),
    sendDecisionId: uuid().references(() => complianceDecisions.id),
    lawfulBasisId: uuid(),
    footerVersion: integer().notNull().default(1),
    blockedReasons: text().array().notNull().default(sql`ARRAY[]::text[]`),
    // Lifecycle
    status: text().$type<OutboundStatus>().notNull(),
    scheduledAt: tz().notNull(),
    leaseUntil: tz(),
    sentAt: tz(),
    providerMessageId: text(),
    rfc822MessageId: text().notNull(),
    providerThreadId: text(),
    inReplyTo: text(),
    attempts: integer().notNull().default(0),
    /** When the last attempt reached for the provider (reconciliation searches from there). */
    lastAttemptAt: tz(),
    lastError: jsonb().$type<OutboundError>(),
    statusHistory: jsonb()
      .$type<{ at: string; status: OutboundStatus; detail: string | null }[]>()
      .notNull()
      .default([]),
    // Control
    idempotencyKey: text().notNull(),
    createdBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    approvedBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    approvedAt: tz(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('uq_outbound_messages__org_idempotency').on(table.organizationId, table.idempotencyKey),
    index('ix_outbound_messages__due')
      .on(table.status, table.scheduledAt)
      .where(sql`${table.status} IN ('queued','sending')`),
    index('ix_outbound_messages__org_business').on(table.organizationId, table.businessId, table.createdAt),
    index('ix_outbound_messages__org_status').on(table.organizationId, table.status, table.scheduledAt),
    index('ix_outbound_messages__thread').on(table.threadId, table.createdAt),
    index('ix_outbound_messages__rfc822').on(table.rfc822MessageId),
    // BF-053: a preview visit (`?r=`) is attributed by its token.
    index('ix_outbound_messages__outreach_token').on(table.outreachToken),
    index('ix_outbound_messages__enrollment').on(table.sequenceEnrollmentId),
    check(
      'ck_outbound_messages__enqueue_decision',
      sql.raw(`status NOT IN (${DECIDED}) OR enqueue_decision_id IS NOT NULL`),
    ),
    check(
      'ck_outbound_messages__send_decision',
      sql.raw(`status NOT IN ('sent','bounced','replied') OR send_decision_id IS NOT NULL`),
    ),
  ],
);

/** A bulk run (BF-052): drafts for up to 100 businesses land in an approval queue; refused ones are listed. */
export const outreachBulkRuns = pgTable(
  'outreach_bulk_runs',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    createdBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    offer: text().$type<Offer>().notNull(),
    purpose: text().$type<EmailPurpose>().notNull(),
    mode: text().$type<'ai' | 'template'>().notNull(),
    templateId: uuid(),
    locale: text().$type<EmailLocale>().notNull(),
    /** Every auto-send condition held when the run started (permission, workspace flag); per item the policy too. */
    autoApprove: boolean().notNull().default(false),
    status: text().$type<'drafting' | 'ready' | 'completed' | 'cancelled'>().notNull().default('drafting'),
    businessIds: uuid().array().notNull(),
    drafted: integer().notNull().default(0),
    skipped: jsonb()
      .$type<
        { businessId: string; decision: string; reasons: string[]; alternatives: string[]; error?: string }[]
      >()
      .notNull()
      .default([]),
    ...timestamps(),
  },
  (table) => [index('ix_outreach_bulk_runs__org_created').on(table.organizationId, table.createdAt)],
);

export const manualContactLogs = pgTable(
  'manual_contact_logs',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    contactId: uuid().references(() => businessContacts.id, { onDelete: 'set null' }),
    channel: text().$type<ManualContactChannel>().notNull(),
    decisionId: uuid()
      .notNull()
      .references(() => complianceDecisions.id),
    summary: text().notNull(),
    outcome: text(),
    createdBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    createdAt: tz().notNull().defaultNow(),
  },
  (table) => [
    index('ix_manual_contact_logs__org_business').on(table.organizationId, table.businessId, table.createdAt),
  ],
);
