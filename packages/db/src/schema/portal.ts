// The client handover portal (BF-062): which sites a business owner may see (a grant per site and email, linked to
// their user on first sign-in), the change requests they send (screenshots in the private assets bucket, a task for
// the agency) and the approvals of proposed versions.

import type { SiteApprovalStatus } from '@bf/contracts';
import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, orgId } from '../columns.ts';
import { citext } from '../types/text.ts';
import { organization, user } from './auth.ts';
import { sites, siteVersions } from './sites.ts';

const tz = () => timestamp({ withTimezone: true });

export const sitePortalGrants = pgTable(
  'site_portal_grants',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    siteId: uuid()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    email: citext().notNull(),
    userId: uuid().references(() => user.id, { onDelete: 'cascade' }),
    invitedBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    acceptedAt: tz(),
    revokedAt: tz(),
    createdAt: tz().notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ux_site_portal_grants__site_email')
      .on(table.siteId, table.email)
      .where(sql`${table.revokedAt} IS NULL`),
    index('ix_site_portal_grants__email').on(table.email),
    index('ix_site_portal_grants__user').on(table.userId),
  ],
);

/** Screenshots uploaded from the portal (private bucket); attached to a change request once it is sent. */
export const sitePortalAttachments = pgTable(
  'site_portal_attachments',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    siteId: uuid()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    uploadedBy: uuid()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    objectKey: text().notNull(),
    contentType: text().notNull(),
    bytes: integer().notNull(),
    changeRequestId: uuid(),
    createdAt: tz().notNull().defaultNow(),
  },
  (table) => [index('ix_site_portal_attachments__request').on(table.changeRequestId)],
);

export const siteChangeRequests = pgTable(
  'site_change_requests',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    siteId: uuid()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    requestedBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    message: text().notNull(),
    pageHint: text(),
    taskId: uuid(),
    createdAt: tz().notNull().defaultNow(),
  },
  (table) => [index('ix_site_change_requests__site').on(table.siteId, table.createdAt)],
);

export const siteApprovals = pgTable(
  'site_approvals',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    siteId: uuid()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    versionId: uuid()
      .notNull()
      .references(() => siteVersions.id, { onDelete: 'cascade' }),
    note: text(),
    status: text().$type<SiteApprovalStatus>().notNull().default('pending'),
    comment: text(),
    requestedBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    requestedAt: tz().notNull().defaultNow(),
    decidedBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    decidedAt: tz(),
  },
  (table) => [
    index('ix_site_approvals__site').on(table.siteId, table.requestedAt),
    uniqueIndex('ux_site_approvals__pending_version')
      .on(table.versionId)
      .where(sql`${table.status} = 'pending'`),
  ],
);
