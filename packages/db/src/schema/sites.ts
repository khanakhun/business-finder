// Sites (BF-035): a workspace's preview websites of businesses, their immutable versions (SiteSpec documents, BF-033),
// their publications (a hostname serving a version, with an expiry), the images they use and their daily views.
// The site renderer (BF-036) reads published versions through the `renderer_published_sites` view only, as the
// read-only `bf_sites_ro` role (migration 0026).

import {
  SITE_ENVIRONMENTS,
  SITE_PUBLICATION_STATUSES,
  SITE_STATUSES,
  SITE_VERSION_AUTHORS,
  type SiteEnvironment,
  type SiteIssue,
  type SitePublicationStatus,
  type SiteStatus,
  type SiteVersionAuthor,
} from '@bf/contracts';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, orgId, timestamps } from '../columns.ts';
import { organization, user } from './auth.ts';
import { businesses } from './business-graph.ts';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));
const tz = () => timestamp({ withTimezone: true });

export const SITE_ASSET_LICENSES = ['owner_site', 'stock', 'ai_generated', 'uploaded'] as const;
export type SiteAssetLicense = (typeof SITE_ASSET_LICENSES)[number];

/** A site: one business's preview website in one workspace. Its content is the current version. */
export const sites = pgTable(
  'sites',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    /** The subdomain of previews (`<slug>.<SITES_BASE_DOMAIN>`): unique across all sites. */
    slug: text().notNull(),
    name: text().notNull(),
    status: text().$type<SiteStatus>().notNull().default('draft'),
    defaultLocale: text().notNull().default('fr'),
    /** The current version (null until the first one); set by the API in the transaction that inserts it. */
    currentVersionId: uuid().references((): AnyPgColumn => siteVersions.id, { onDelete: 'set null' }),
    createdBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('uq_sites__slug').on(table.slug),
    // Listing per workspace (newest first) and a business's sites.
    index('idx_sites__organization_id_created_at').on(table.organizationId, table.createdAt.desc()),
    index('idx_sites__organization_id_business_id').on(table.organizationId, table.businessId),
    index('idx_sites__business_id').on(table.businessId),
    check('ck_sites__status', sql`${table.status} IN (${inList(SITE_STATUSES)})`),
    check('ck_sites__slug', sql`${table.slug} ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'`),
  ],
);

/**
 * The versions of a site: immutable SiteSpec documents (a trigger refuses every UPDATE except setting `quality` once,
 * BF-045). `version_number` counts per site from 1.
 */
export const siteVersions = pgTable(
  'site_versions',
  {
    id: id(),
    siteId: uuid()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    versionNumber: integer().notNull(),
    spec: jsonb().$type<Record<string, unknown>>().notNull(),
    /** SHA-256 of the spec's canonical JSON (hex). */
    specHash: text().notNull(),
    schemaVersion: smallint().notNull(),
    authorType: text().$type<SiteVersionAuthor>().notNull(),
    /** The user, generation job or chat edit that made it (an id of that author kind). */
    authorId: text(),
    parentVersionId: uuid(),
    changeSummary: text(),
    /** The validators' warnings (errors never reach a version). */
    validation: jsonb().$type<{ issues: SiteIssue[] }>().notNull(),
    /** The quality gates' report (BF-045): set once. */
    quality: jsonb().$type<Record<string, unknown>>(),
    createdAt: tz().notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_site_versions__site_id_version_number').on(table.siteId, table.versionNumber),
    // NO ACTION (checked at the end of the statement): deleting a site deletes all its versions at once, and a
    // SET NULL would be an UPDATE the immutability trigger refuses.
    foreignKey({
      name: 'fk_site_versions__parent_version',
      columns: [table.parentVersionId],
      foreignColumns: [table.id],
    }),
    check('ck_site_versions__version_number', sql`${table.versionNumber} >= 1`),
    check('ck_site_versions__author_type', sql`${table.authorType} IN (${inList(SITE_VERSION_AUTHORS)})`),
    check('ck_site_versions__spec_hash', sql`${table.specHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * Publications: a hostname serving a version in an environment. At most one active per site and environment, and
 * an active hostname serves one site; ended ones stay as history.
 */
export const sitePublications = pgTable(
  'site_publications',
  {
    id: id(),
    siteId: uuid()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    versionId: uuid()
      .notNull()
      // NO ACTION: a version stays while a publication names it (a site's deletion removes both at once).
      .references(() => siteVersions.id),
    environment: text().$type<SiteEnvironment>().notNull(),
    hostname: text().notNull(),
    status: text().$type<SitePublicationStatus>().notNull().default('active'),
    publishedBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    publishedAt: tz().notNull().defaultNow(),
    expiresAt: tz(),
    endedAt: tz(),
  },
  (table) => [
    uniqueIndex('uq_site_publications__active_environment')
      .on(table.siteId, table.environment)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex('uq_site_publications__active_hostname')
      .on(table.hostname)
      .where(sql`${table.status} = 'active'`),
    // The expiry job's scan.
    index('idx_site_publications__expires_at')
      .on(table.expiresAt)
      .where(sql`${table.status} = 'active' AND ${table.expiresAt} IS NOT NULL`),
    index('idx_site_publications__version_id').on(table.versionId),
    // The renderer looks a host up across all publications (an ended one answers 410): not only active ones.
    index('idx_site_publications__hostname').on(table.hostname),
    check('ck_site_publications__environment', sql`${table.environment} IN (${inList(SITE_ENVIRONMENTS)})`),
    check('ck_site_publications__status', sql`${table.status} IN (${inList(SITE_PUBLICATION_STATUSES)})`),
    check('ck_site_publications__ended', sql`(${table.status} = 'active') = (${table.endedAt} IS NULL)`),
  ],
);

/** Images a site (or the workspace library, `site_id` null) uses; originals private, variants public (BF-035/038). */
export const siteAssets = pgTable(
  'site_assets',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    siteId: uuid().references(() => sites.id, { onDelete: 'cascade' }),
    businessId: uuid().references(() => businesses.id, { onDelete: 'set null' }),
    storageKey: text().notNull(),
    publicUrl: text(),
    mime: text().notNull(),
    width: integer(),
    height: integer(),
    bytes: bigint({ mode: 'number' }),
    sha256: text(),
    /** Resized/re-encoded copies: `[{ width, format, key, url, bytes }]`. */
    variants: jsonb().$type<{ width: number; format: string; key: string; url: string; bytes: number }[]>(),
    license: text().$type<SiteAssetLicense>().notNull(),
    /** `author`, `sourceUrl`, `attributionText`, `provider`. */
    licenseDetails: jsonb().$type<Record<string, string>>(),
    alt: jsonb().$type<Record<string, string>>(),
    dominantColors: jsonb().$type<string[]>(),
    focalPoint: jsonb().$type<{ x: number; y: number }>(),
    /** `pending` until the upload is finalized and processed. */
    status: text().$type<'pending' | 'processing' | 'ready' | 'failed'>().notNull().default('pending'),
    createdBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    createdAt: tz().notNull().defaultNow(),
  },
  (table) => [
    index('idx_site_assets__organization_id_site_id').on(table.organizationId, table.siteId),
    uniqueIndex('uq_site_assets__storage_key').on(table.storageKey),
    check('ck_site_assets__license', sql`${table.license} IN (${inList(SITE_ASSET_LICENSES)})`),
    check('ck_site_assets__status', sql`${table.status} IN ('pending', 'processing', 'ready', 'failed')`),
  ],
);

/** Daily view counts per site (no raw IP or user agent is ever stored: unique visitors are a HyperLogLog estimate). */
export const siteViewDaily = pgTable(
  'site_view_daily',
  {
    siteId: uuid()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    day: date({ mode: 'string' }).notNull(),
    pageViews: integer().notNull().default(0),
    uniqueEstimate: integer().notNull().default(0),
    byLocale: jsonb().$type<Record<string, number>>().notNull().default({}),
    byCampaign: jsonb().$type<Record<string, number>>().notNull().default({}),
  },
  (table) => [
    primaryKey({ name: 'pk_site_view_daily', columns: [table.siteId, table.day] }),
    check('ck_site_view_daily__counts', sql`${table.pageViews} >= 0 AND ${table.uniqueEstimate} >= 0`),
  ],
);
