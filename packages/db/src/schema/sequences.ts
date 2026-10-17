// Sequences (BF-053): definitions with immutable versions, enrollments (one active or paused per business and
// workspace), their audit trail, and the preview views attributed to an outbound message (cookieless, by the
// `?r=` outreach token: no personal data).

import type { EnrollmentStatus, Offer, SequenceSettings, SequenceStep } from '@bf/contracts';
import { sql } from 'drizzle-orm';
import {
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
import { organization, user } from './auth.ts';
import { businessContacts, businesses } from './business-graph.ts';
import { mailboxes } from './mailboxes.ts';
import { emailThreads, outboundMessages } from './outbound.ts';

const tz = () => timestamp({ withTimezone: true });

export const sequences = pgTable(
  'sequences',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    offer: text().$type<Offer>().notNull(),
    status: text().$type<'draft' | 'active' | 'archived'>().notNull().default('draft'),
    headVersion: integer().notNull().default(1),
    ...timestamps(),
  },
  (table) => [index('ix_sequences__org').on(table.organizationId, table.status)],
);

export const sequenceVersions = pgTable(
  'sequence_versions',
  {
    id: id(),
    sequenceId: uuid()
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    settings: jsonb().$type<SequenceSettings>().notNull(),
    steps: jsonb().$type<SequenceStep[]>().notNull(),
    createdBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    createdAt: tz().notNull().defaultNow(),
  },
  (table) => [uniqueIndex('uq_sequence_versions__sequence_version').on(table.sequenceId, table.version)],
);

export const sequenceEnrollments = pgTable(
  'sequence_enrollments',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    sequenceVersionId: uuid()
      .notNull()
      .references(() => sequenceVersions.id),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    contactId: uuid().references(() => businessContacts.id, { onDelete: 'set null' }),
    /** Sticky after the first send (follow-ups come from the same sender). */
    mailboxId: uuid().references(() => mailboxes.id, { onDelete: 'set null' }),
    threadId: uuid().references(() => emailThreads.id, { onDelete: 'set null' }),
    status: text().$type<EnrollmentStatus>().notNull().default('active'),
    currentStepIndex: integer().notNull().default(0),
    nextRunAt: tz(),
    /** The step being executed waits for this message (approval, sending). */
    waitingMessageId: uuid().references(() => outboundMessages.id, { onDelete: 'set null' }),
    leaseUntil: tz(),
    variantAssignments: jsonb().$type<Record<string, string>>().notNull().default({}),
    stopReason: text(),
    pauseReason: text(),
    stoppedAt: tz(),
    enrolledBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('uq_sequence_enrollments__one_running')
      .on(table.organizationId, table.businessId)
      .where(sql`${table.status} IN ('active','paused')`),
    index('ix_sequence_enrollments__due')
      .on(table.status, table.nextRunAt)
      .where(sql`${table.status} = 'active'`),
    index('ix_sequence_enrollments__org_business').on(table.organizationId, table.businessId),
  ],
);

export const enrollmentEvents = pgTable(
  'enrollment_events',
  {
    id: id(),
    enrollmentId: uuid()
      .notNull()
      .references(() => sequenceEnrollments.id, { onDelete: 'cascade' }),
    kind: text()
      .$type<
        'enrolled' | 'executed' | 'skipped' | 'paused' | 'resumed' | 'stopped' | 'rescheduled' | 'completed'
      >()
      .notNull(),
    stepId: text(),
    variantId: text(),
    detail: text(),
    messageId: uuid().references(() => outboundMessages.id, { onDelete: 'set null' }),
    at: tz().notNull().defaultNow(),
  },
  (table) => [index('ix_enrollment_events__enrollment').on(table.enrollmentId, table.at)],
);

export const outboundMessageViews = pgTable(
  'outbound_message_views',
  {
    outboundMessageId: uuid()
      .notNull()
      .references(() => outboundMessages.id, { onDelete: 'cascade' }),
    firstViewedAt: tz().notNull(),
    lastViewedAt: tz().notNull(),
    views: integer().notNull().default(1),
  },
  (table) => [primaryKey({ columns: [table.outboundMessageId] })],
);
