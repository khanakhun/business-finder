// Geo context (BF-017): imported and custom areas, and the external geocoder cache.

import { GEO_AREA_KINDS, GEO_AREA_SOURCES, type GeoAreaKind, type GeoAreaSource } from '@bf/contracts';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from '../columns.ts';
import { geographyMultiPolygon, geographyPoint } from '../types/geography.ts';
import { organization } from './auth.ts';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));
const tz = () => timestamp({ withTimezone: true });

/**
 * Areas users scope searches with: imported packs (global, `organization_id` null) and areas a workspace draws
 * (`custom`, visible to that workspace only). `normalized_names` (exact lookups) and `search_text` (trigram) are
 * maintained by the application from `name` and `aliases`.
 */
export const geoAreas = pgTable(
  'geo_areas',
  {
    id: id(),
    kind: text().$type<GeoAreaKind>().notNull(),
    countryCode: text(),
    /** Postal code, ZIP, admin code. */
    code: text(),
    name: jsonb().$type<{ en: string; fr: string; local?: string }>().notNull(),
    /** Display aliases ("St Barth", "SBH"). */
    aliases: text().array().notNull().default(sql`ARRAY[]::text[]`),
    /** Every name and alias normalized (accents, case, abbreviations): exact matches. */
    normalizedNames: text().array().notNull().default(sql`ARRAY[]::text[]`),
    searchText: text().notNull(),
    parentId: uuid().references((): AnyPgColumn => geoAreas.id, { onDelete: 'set null' }),
    geom: geographyMultiPolygon().notNull(),
    centroid: geographyPoint(),
    /** Boundary derived from points (Voronoi cells), not surveyed. */
    approximate: boolean().notNull().default(false),
    source: text().$type<GeoAreaSource>().notNull(),
    /** Id in the source (OSM element, PC4, ZCTA): makes pack imports idempotent. */
    sourceRef: text(),
    areaKm2: real(),
    /** Owner of a `custom` area; null for imported (global) areas. */
    organizationId: uuid().references(() => organization.id, { onDelete: 'cascade' }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('uq_geo_areas__source_source_ref').on(table.source, table.sourceRef),
    index('idx_geo_areas__geom').using('gist', table.geom),
    index('idx_geo_areas__search_text').using('gin', table.searchText.op('gin_trgm_ops')),
    index('idx_geo_areas__normalized_names').using('gin', table.normalizedNames),
    index('idx_geo_areas__country_code_kind').on(table.countryCode, table.kind),
    index('idx_geo_areas__kind_code').on(table.kind, table.code),
    index('idx_geo_areas__parent_id').on(table.parentId),
    index('idx_geo_areas__organization_id').on(table.organizationId),
    check('ck_geo_areas__kind', sql`${table.kind} IN (${inList(GEO_AREA_KINDS)})`),
    check('ck_geo_areas__source', sql`${table.source} IN (${inList(GEO_AREA_SOURCES)})`),
    check('ck_geo_areas__country_code', sql`${table.countryCode} ~ '^[A-Z]{2}$'`),
    check(
      'ck_geo_areas__custom_owner',
      sql`(${table.kind} = 'custom') = (${table.organizationId} IS NOT NULL)`,
    ),
  ],
);

/** External geocoder answers (Nominatim policy: cache, don't repeat). `country_hint` is '' when none. */
export const geocodeCache = pgTable(
  'geocode_cache',
  {
    queryNormalized: text().notNull(),
    provider: text().notNull(),
    countryHint: text().notNull().default(''),
    /** Answer language (labels are localized by the provider). */
    locale: text().notNull().default(''),
    /** '' for answers every workspace may share; the workspace id for per-key providers (Google). */
    scope: text().notNull().default(''),
    result: jsonb().$type<unknown>().notNull(),
    createdAt: tz().notNull().defaultNow(),
    expiresAt: tz().notNull(),
  },
  (table) => [
    primaryKey({
      name: 'geocode_cache_pkey',
      columns: [table.queryNormalized, table.provider, table.countryHint, table.locale, table.scope],
    }),
    index('idx_geocode_cache__expires_at').on(table.expiresAt),
  ],
);
