// Deliverability (BF-056): the latest authentication check of each sending domain of a workspace (cached; re-run
// daily and on demand), and an owner's explicit, audited override that lets a mailbox send despite failing checks.

import type { CheckOutcome, DnsCheck } from '@bf/contracts';
import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, orgId } from '../columns.ts';
import { organization, user } from './auth.ts';
import { mailboxes } from './mailboxes.ts';

const tz = () => timestamp({ withTimezone: true });

export const deliverabilityDomains = pgTable(
  'deliverability_domains',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    domain: text().notNull(),
    provider: text().$type<'gmail' | 'graph' | 'smtp_imap' | 'unknown'>().notNull(),
    outcome: text().$type<CheckOutcome>().notNull(),
    checks: jsonb().$type<DnsCheck[]>().notNull(),
    checkedAt: tz().notNull(),
  },
  (table) => [uniqueIndex('uq_deliverability_domains__org_domain').on(table.organizationId, table.domain)],
);

export const mailboxReadinessOverrides = pgTable('mailbox_readiness_overrides', {
  mailboxId: uuid()
    .primaryKey()
    .references(() => mailboxes.id, { onDelete: 'cascade' }),
  organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
  reason: text().notNull(),
  createdBy: uuid().references(() => user.id, { onDelete: 'set null' }),
  createdAt: tz().notNull().defaultNow(),
});

/** The workspace's kill switch (BF-056): "stop all sending", effective within seconds (cached in Valkey). */
export const deliverabilitySettings = pgTable('deliverability_settings', {
  organizationId: uuid()
    .primaryKey()
    .references(() => organization.id, { onDelete: 'cascade' }),
  killSwitch: boolean().notNull().default(false),
  killReason: text(),
  killBy: uuid().references(() => user.id, { onDelete: 'set null' }),
  killAt: tz(),
  updatedAt: tz().notNull().defaultNow(),
});
