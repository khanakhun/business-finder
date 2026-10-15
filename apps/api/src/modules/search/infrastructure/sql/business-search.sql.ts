import {
  businessCategories,
  businessContacts,
  businesses,
  categories,
  geoAreas,
  orgBusinesses,
} from '@bf/db/schema';
import { type SQL, sql } from 'drizzle-orm';
import type { FacetDimension, ListingPosition, ListingSort, ListingSpec } from '../../domain/listing.ts';

// Listing specification → SQL (BF-022). Every value is a bound parameter; only fixed fragments are raw. Columns are
// referenced through the Drizzle tables, so queries read `FROM org_businesses JOIN businesses`.

const and = (parts: ReadonlyArray<SQL | undefined>): SQL => {
  const present = parts.filter((p): p is SQL => p !== undefined);
  return present.length === 0 ? sql`TRUE` : sql.join(present, sql` AND `);
};

/** `ARRAY[$1, $2]::<type>[]` (Drizzle would expand a JS array into a row). */
export const arrayOf = (values: readonly (string | number)[], type: 'text' | 'uuid' | 'smallint') =>
  sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::${sql.raw(type)}[]`;

/** Accent-insensitive web-style query across the three text configs of `search_tsv` (`bf_tsvector`). */
export const tsQuery = (text: string) =>
  sql`(websearch_to_tsquery('simple', f_unaccent(${text})) || websearch_to_tsquery('french', f_unaccent(${text})) || websearch_to_tsquery('english', f_unaccent(${text})))`;

export const point = (p: { readonly lat: number; readonly lng: number }) =>
  sql`ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326)::geography`;

const hasContact = (type: 'email' | 'phone', verified = false) =>
  sql`EXISTS (SELECT 1 FROM ${businessContacts} bc WHERE bc.business_id = ${businesses.id} AND bc.type = ${type}${
    verified ? sql` AND bc.verification_status = 'valid'` : sql``
  })`;

/** WHERE for a listing; `omit` drops one facet dimension's own filter (standard faceting). */
export function filterSql(spec: ListingSpec, omit?: FacetDimension): SQL {
  const f = spec.filters;
  const on = (dimension: FacetDimension) => omit !== dimension;
  const hasPhone = sql`(${businesses.primaryPhoneE164} IS NOT NULL OR ${hasContact('phone')})`;
  return and([
    sql`${orgBusinesses.organizationId} = ${spec.organizationId}`,
    sql`${businesses.mergedIntoId} IS NULL`,
    f.includeClosed ? undefined : sql`${businesses.operatingStatus} <> 'closed_permanently'`,
    on('category') && f.category?.length
      ? sql`EXISTS (SELECT 1 FROM ${businessCategories} bcat JOIN ${categories} c ON c.id = bcat.category_id
          WHERE bcat.business_id = ${businesses.id}
            AND c.path <@ ARRAY(SELECT sel.path FROM ${categories} sel WHERE sel.id = ANY(${arrayOf(f.category, 'uuid')})))`
      : undefined,
    f.area
      ? sql`EXISTS (SELECT 1 FROM ${geoAreas} ga WHERE ga.id = ${f.area}
          AND (ga.organization_id IS NULL OR ga.organization_id = ${spec.organizationId})
          AND ST_Intersects(${businesses.location}, ga.geom))`
      : undefined,
    f.near ? sql`ST_DWithin(${businesses.location}, ${point(f.near)}, ${f.radiusKm * 1000})` : undefined,
    f.country ? sql`${businesses.countryCode} = ${f.country}` : undefined,
    // DECISION(BF-022): `weak` needs audit scores (BF-030/BF-031); until then it means "has a website".
    on('website') && f.website === 'none' ? sql`${businesses.websiteUrl} IS NULL` : undefined,
    on('website') && (f.website === 'has' || f.website === 'weak')
      ? sql`${businesses.websiteUrl} IS NOT NULL`
      : undefined,
    on('rating') && f['rating[gte]'] !== undefined
      ? sql`${businesses.ratingAvg} >= ${f['rating[gte]']}`
      : undefined,
    on('rating') && f['rating[lte]'] !== undefined
      ? sql`${businesses.ratingAvg} <= ${f['rating[lte]']}`
      : undefined,
    f['reviews[gte]'] !== undefined ? sql`${businesses.ratingCount} >= ${f['reviews[gte]']}` : undefined,
    f['reviews[lte]'] !== undefined ? sql`${businesses.ratingCount} <= ${f['reviews[lte]']}` : undefined,
    f['score[gte]'] !== undefined ? sql`${orgBusinesses.score} >= ${f['score[gte]']}` : undefined,
    f['score[lte]'] !== undefined ? sql`${orgBusinesses.score} <= ${f['score[lte]']}` : undefined,
    f.price?.length ? sql`${businesses.priceLevel} = ANY(${arrayOf(f.price, 'smallint')})` : undefined,
    on('email') && f.hasEmail === true ? hasContact('email') : undefined,
    on('email') && f.hasEmail === false ? sql`NOT ${hasContact('email')}` : undefined,
    f.emailVerified === true ? hasContact('email', true) : undefined,
    f.emailVerified === false ? sql`NOT ${hasContact('email', true)}` : undefined,
    f.hasPhone === true ? hasPhone : undefined,
    f.hasPhone === false ? sql`NOT ${hasPhone}` : undefined,
    on('status') && f.status?.length
      ? sql`${orgBusinesses.pipelineStatus} = ANY(${arrayOf(f.status, 'text')})`
      : undefined,
    on('tier') && f.tier?.length ? sql`${orgBusinesses.tier} = ANY(${arrayOf(f.tier, 'text')})` : undefined,
    f.tag?.length ? sql`${orgBusinesses.tags} && ${arrayOf(f.tag, 'text')}` : undefined,
    f.owner ? sql`${orgBusinesses.ownerUserId} = ${f.owner}` : undefined,
    spec.addedSince
      ? sql`${orgBusinesses.createdAt} >= ${spec.addedSince.toISOString()}::timestamptz`
      : undefined,
    ...(spec.text?.keywords ?? []).map((keyword) => sql`${businesses.searchTsv} @@ ${tsQuery(keyword)}`),
  ]);
}

/** A sortable key: its SQL, whether it can be null (nulls always last) and how its cursor value is typed. */
export interface SortKeySql {
  readonly expr: SQL;
  /** The value as stored in a cursor (timestamps as microsecond ISO text, never lossy JS dates). */
  readonly cursorValue: SQL;
  readonly nullable: boolean;
  readonly type: 'timestamp' | 'number' | 'text';
}

export function sortKeySql(sort: ListingSort, origin: ListingSpec['origin']): SortKeySql {
  switch (sort.key) {
    case 'recent':
      return {
        expr: sql`${orgBusinesses.createdAt}`,
        cursorValue: sql`to_char(${orgBusinesses.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        nullable: false,
        type: 'timestamp',
      };
    case 'score':
      return {
        expr: sql`${orgBusinesses.score}`,
        cursorValue: sql`${orgBusinesses.score}`,
        nullable: true,
        type: 'number',
      };
    case 'rating':
      return {
        expr: sql`${businesses.ratingAvg}`,
        cursorValue: sql`${businesses.ratingAvg}::float8`,
        nullable: true,
        type: 'number',
      };
    case 'reviews':
      return {
        expr: sql`${businesses.ratingCount}`,
        cursorValue: sql`${businesses.ratingCount}`,
        nullable: true,
        type: 'number',
      };
    case 'name':
      return {
        expr: sql`${businesses.normalizedName}`,
        cursorValue: sql`${businesses.normalizedName}`,
        nullable: false,
        type: 'text',
      };
    case 'distance': {
      if (!origin) throw new Error('distance sort without an origin');
      const distance = sql`ST_Distance(${businesses.location}, ${point(origin)})`;
      return { expr: distance, cursorValue: sql`${distance}::float8`, nullable: true, type: 'number' };
    }
    case 'relevance':
      throw new Error('relevance is ranked in the application (RRF), not sorted in SQL');
  }
}

export function orderSql(key: SortKeySql, sort: ListingSort): SQL {
  const direction = sql.raw(sort.direction === 'desc' ? 'DESC' : 'ASC');
  return sql`${key.expr} ${direction} NULLS LAST, ${businesses.id} ${direction}`;
}

const typed = (key: SortKeySql, value: string | number) =>
  key.type === 'timestamp'
    ? sql`${value}::timestamptz`
    : key.type === 'number'
      ? sql`${value}::float8`
      : sql`${value}`;

/**
 * Rows after `position` in (key, id) order with nulls last. A non-null key uses a row comparison (index-friendly);
 * a nullable one spells out "smaller key, or same key and smaller id, or no key at all".
 */
export function keysetSql(key: SortKeySql, sort: ListingSort, position: ListingPosition): SQL {
  const before = sort.direction === 'desc' ? sql.raw('<') : sql.raw('>');
  const id = sql`${position.id}::uuid`;
  if (position.value === null) return sql`(${key.expr} IS NULL AND ${businesses.id} ${before} ${id})`;
  const value = typed(key, position.value);
  if (!key.nullable) return sql`(${key.expr}, ${businesses.id}) ${before} (${value}, ${id})`;
  return sql`(${key.expr} ${before} ${value} OR (${key.expr} = ${value} AND ${businesses.id} ${before} ${id}) OR ${key.expr} IS NULL)`;
}
