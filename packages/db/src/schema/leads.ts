// Leads from preview sites (BF-048): claims, contact requests and opt-outs, with consent, attribution and the spam
// verdict. No raw IP is ever stored. Kept 24 months (spam 30 days), then purged.

import {
  LEAD_KINDS,
  LEAD_SOURCES,
  LEAD_STATUSES,
  type LeadAttribution,
  type LeadKind,
  type LeadSource,
  type LeadStatus,
  type SpamVerdict,
} from '@bf/contracts';
import { index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, orgId, timestamps } from '../columns.ts';
import { citext } from '../types/text.ts';
import { organization, user } from './auth.ts';
import { businesses } from './business-graph.ts';
import { sitePublications, sites } from './sites.ts';

export const siteLeads = pgTable(
  'site_leads',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    siteId: uuid()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    publicationId: uuid().references(() => sitePublications.id, { onDelete: 'set null' }),
    kind: text({ enum: LEAD_KINDS }).$type<LeadKind>().notNull(),
    source: text({ enum: LEAD_SOURCES }).$type<LeadSource>().notNull(),
    name: text(),
    email: citext(),
    /** E.164 when it parses; as typed otherwise. */
    phone: text(),
    whatsapp: text(),
    message: text(),
    preferredChannel: text().$type<'phone' | 'whatsapp' | 'email'>(),
    preferredTime: text(),
    locale: text().notNull(),
    consent: jsonb().$type<{ checked: boolean; textVersion: string; at: string }>().notNull(),
    attribution: jsonb().$type<LeadAttribution>().notNull(),
    spam: jsonb().$type<SpamVerdict>().notNull(),
    status: text({ enum: LEAD_STATUSES }).$type<LeadStatus>().notNull().default('new'),
    handledBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    /** The form's submission id: a retry of the same submission is the same lead. */
    submissionId: uuid().notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('site_leads_submission_key').on(table.siteId, table.submissionId),
    index('site_leads_inbox_idx').on(table.organizationId, table.status, table.createdAt),
    index('site_leads_business_idx').on(table.organizationId, table.businessId),
  ],
);
