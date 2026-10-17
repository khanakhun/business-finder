// Going live (BF-062): a site's legal profile (versioned by a counter; the legal pages are generated from it) and
// where its contact form is delivered (an address confirmed by a link; only the token's hash is kept).

import type { SITE_DOMAIN_KINDS, SiteDomain, SiteDomainStatus } from '@bf/contracts';
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, orgId } from '../columns.ts';
import { citext } from '../types/text.ts';
import { organization, user } from './auth.ts';
import { sites } from './sites.ts';

const tz = () => timestamp({ withTimezone: true });

export const siteLegalProfiles = pgTable('site_legal_profiles', {
  siteId: uuid()
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
  businessLegalName: text().notNull(),
  legalForm: text(),
  registration: text(),
  vatNumber: text(),
  address: text().notNull(),
  phone: text(),
  email: citext().notNull(),
  publicationDirector: text(),
  dpoContact: text(),
  privacyAcknowledgedAt: tz(),
  contentConfirmedBy: text(),
  contentConfirmedAt: tz(),
  version: integer().notNull().default(1),
  updatedBy: uuid().references(() => user.id, { onDelete: 'set null' }),
  updatedAt: tz().notNull().defaultNow(),
});

export const siteContactRouting = pgTable(
  'site_contact_routing',
  {
    siteId: uuid()
      .primaryKey()
      .references(() => sites.id, { onDelete: 'cascade' }),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    recipientEmail: citext(),
    cc: citext(),
    verifiedAt: tz(),
    pendingEmail: citext(),
    pendingCc: citext(),
    /** SHA-256 of the confirmation link's token. */
    tokenHash: text(),
    tokenExpiresAt: tz(),
    updatedAt: tz().notNull().defaultNow(),
  },
  (table) => [index('ix_site_contact_routing__token').on(table.tokenHash)],
);

/**
 * Custom domains of sites (BF-062): verified by a TXT token and their routing records, then served with a
 * certificate issued on demand (Caddy asks the API, which allows verified or active names only).
 */
export const siteDomains = pgTable(
  'site_domains',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    siteId: uuid()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    hostname: citext().notNull(),
    kind: text().$type<(typeof SITE_DOMAIN_KINDS)[number]>().notNull(),
    redirectTo: citext(),
    verificationToken: text().notNull(),
    status: text().$type<SiteDomainStatus>().notNull().default('pending_dns'),
    dnsReport: jsonb().$type<SiteDomain['report']>(),
    tlsStatus: text(),
    attempts: integer().notNull().default(0),
    lastCheckedAt: tz(),
    nextCheckAt: tz().notNull().defaultNow(),
    createdBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    createdAt: tz().notNull().defaultNow(),
    updatedAt: tz().notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_site_domains__hostname').on(table.hostname),
    index('ix_site_domains__site').on(table.siteId),
    index('ix_site_domains__due').on(table.status, table.nextCheckAt),
  ],
);
