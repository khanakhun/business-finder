// The site renderer's read models (migration 0026, BF-036): SQL views created by the migration, declared here for
// typed reads as `bf_sites_ro`. Kept out of src/schema (drizzle-kit manages tables there and cannot generate around
// existing views).

import type { SiteEnvironment, SitePublicationStatus } from '@bf/contracts';
import { boolean, integer, jsonb, pgView, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The site renderer's read model (migration 0026, BF-036): per hostname, its latest publication with an effective
 * status (`active`, `expired`, `unpublished`) — the spec only when active. Read-only, as `bf_sites_ro`; declared
 * `.existing()` so drizzle-kit leaves the SQL view to the migration.
 */
export const rendererPublishedSites = pgView('renderer_published_sites', {
  hostname: text().notNull(),
  siteId: uuid().notNull(),
  status: text().$type<SitePublicationStatus>().notNull(),
  businessName: text().notNull(),
  agencyName: text().notNull(),
  /** The agency's website, only when it is an http(s) URL. */
  agencyUrl: text(),
  environment: text().$type<SiteEnvironment>().notNull(),
  versionId: uuid().notNull(),
  spec: jsonb().$type<Record<string, unknown>>(),
  expiresAt: timestamp({ withTimezone: true }),
  noindex: boolean().notNull(),
  previewBanner: boolean().notNull(),
}).existing();

/** The images the renderer may serve: ready assets of sites with an active publication. */
export const rendererSiteAssets = pgView('renderer_site_assets', {
  id: uuid().notNull(),
  siteId: uuid(),
  publicUrl: text(),
  mime: text().notNull(),
  width: integer(),
  height: integer(),
  variants: jsonb().$type<{ width: number; format: string; key: string; url: string; bytes: number }[]>(),
  alt: jsonb().$type<Record<string, string>>(),
  focalPoint: jsonb().$type<{ x: number; y: number }>(),
  dominantColors: jsonb().$type<string[]>(),
}).existing();

/** BF-062: a live site's legal profile and its host (the agency), for the legal notice and privacy pages. */
export const rendererSiteLegal = pgView('renderer_site_legal', {
  siteId: uuid().notNull(),
  businessLegalName: text().notNull(),
  legalForm: text(),
  registration: text(),
  vatNumber: text(),
  address: text().notNull(),
  phone: text(),
  email: text().notNull(),
  publicationDirector: text(),
  dpoContact: text(),
  hostName: text().notNull(),
  hostAddress: text(),
  hostUrl: text(),
  version: integer().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull(),
}).existing();
