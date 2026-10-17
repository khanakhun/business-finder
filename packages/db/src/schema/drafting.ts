// Email templates and drafts (BF-051). Template versions are immutable (a new version is a new row with the same
// key); seeded templates belong to no workspace (`organization_id` null) and are copied into a workspace on edit.

import type { DraftFactRef, EmailLocale, EmailPurpose, LintIssue, Offer } from '@bf/contracts';
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps } from '../columns.ts';
import { organization, user } from './auth.ts';
import { businessContacts, businesses } from './business-graph.ts';
import { mailboxes } from './mailboxes.ts';
import { sites } from './sites.ts';

export const emailTemplates = pgTable(
  'email_templates',
  {
    id: id(),
    organizationId: uuid().references(() => organization.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    name: text().notNull(),
    purpose: text().$type<EmailPurpose>().notNull(),
    offer: text().$type<Offer>().notNull(),
    locale: text().$type<EmailLocale>().notNull(),
    version: integer().notNull(),
    subjectVariants: text().array().notNull(),
    bodyMd: text().notNull(),
    variables: text().array().notNull().default(sql`ARRAY[]::text[]`),
    status: text().$type<'active' | 'archived'>().notNull().default('active'),
    seeded: boolean().notNull().default(false),
    lint: jsonb().$type<LintIssue[]>().notNull().default([]),
    createdBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_email_templates__owner_key_locale_version')
      .on(table.organizationId, table.key, table.locale, table.version)
      .nullsNotDistinct(),
    index('ix_email_templates__org_key').on(table.organizationId, table.key),
  ],
);

export const emailDrafts = pgTable(
  'email_drafts',
  {
    id: id(),
    organizationId: uuid()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    contactId: uuid().references(() => businessContacts.id, { onDelete: 'set null' }),
    mailboxId: uuid().references(() => mailboxes.id, { onDelete: 'set null' }),
    templateId: uuid().references(() => emailTemplates.id, { onDelete: 'set null' }),
    templateVersion: integer(),
    purpose: text().$type<EmailPurpose>().notNull(),
    offer: text().$type<Offer>().notNull(),
    locale: text().$type<EmailLocale>().notNull(),
    subject: text().notNull(),
    subjectVariants: text().array().notNull().default(sql`ARRAY[]::text[]`),
    bodyMd: text().notNull(),
    factsUsed: jsonb().$type<DraftFactRef[]>().notNull().default([]),
    claims: jsonb()
      .$type<{ text: string; supportedBy: string[]; supported: boolean }[]>()
      .notNull()
      .default([]),
    lint: jsonb().$type<LintIssue[]>().notNull().default([]),
    generatedBy: text().$type<'ai' | 'template' | 'human'>().notNull(),
    aiMeta: jsonb().$type<Record<string, unknown>>(),
    siteId: uuid().references(() => sites.id, { onDelete: 'set null' }),
    compliancePreview: jsonb().$type<Record<string, unknown>>(),
    status: text().$type<'draft' | 'discarded' | 'sent_as_message'>().notNull().default('draft'),
    createdBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (table) => [
    index('ix_email_drafts__org_business').on(table.organizationId, table.businessId, table.createdAt),
  ],
);
