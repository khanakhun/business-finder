// Business graph context (BF-014): global facts about businesses (ADR-0008), shared by every workspace.
// Index names follow coding-standards §5 (`idx_` / `uq_` / `ck_`).

import {
  CONTACT_TYPES,
  type ContactType,
  type LocalizedText,
  MEDIA_KINDS,
  MEDIA_LICENSES,
  OPERATING_STATUSES,
  type OperatingStatus,
  type PostalAddress,
  type Provenance,
  SOURCE_PROVIDERS,
  type SourceProvider,
  VERIFICATION_STATUSES,
} from '@bf/contracts';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from '../columns.ts';
import { geographyPoint } from '../types/geography.ts';
import { citext, ltree } from '../types/text.ts';
import { organization } from './auth.ts';

const tz = () => timestamp({ withTimezone: true });
const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export const DUPLICATE_STATUS_VALUES = ['open', 'merged', 'dismissed'] as const;

/** Taxonomy skeleton; BF-015 completes it (synonyms, mappings, embeddings, GiST on `path`). */
export const categories = pgTable(
  'categories',
  {
    id: id(),
    slug: text().notNull(),
    parentId: uuid().references((): AnyPgColumn => categories.id, { onDelete: 'restrict' }),
    /** Dotted slugs from the root (`food_drink.cafe`). */
    path: ltree().notNull(),
    labels: jsonb().$type<LocalizedText>().notNull(),
    isActive: boolean().notNull().default(true),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('uq_categories__slug').on(table.slug),
    index('idx_categories__parent_id').on(table.parentId),
  ],
);

/**
 * Golden records. Golden columns mirror the value chosen per field; `attributes` holds each field's provenance
 * (`{ field: { value, source, sourceRef, confidence, observedAt } }`). `version` guards concurrent saves.
 */
export const businesses = pgTable(
  'businesses',
  {
    id: id(),
    displayName: text().notNull(),
    /** Lowercase, unaccented, legal suffixes stripped (`BusinessName`). */
    normalizedName: text().notNull(),
    primaryCategoryId: uuid().references(() => categories.id, { onDelete: 'set null' }),
    operatingStatus: text().$type<OperatingStatus>().notNull().default('unknown'),
    websiteUrl: text(),
    websiteHost: text(),
    /** Null for shared hosts (`*.wixsite.com`, `facebook.com`, …): never a matching key. */
    websiteRegistrableDomain: text(),
    primaryPhoneE164: text('primary_phone_e164'),
    countryCode: text(),
    localeHint: text(),
    location: geographyPoint(),
    address: jsonb().$type<Partial<PostalAddress>>(),
    formattedAddress: text(),
    locality: text(),
    postalCode: text(),
    priceLevel: smallint(),
    ratingAvg: numeric({ precision: 2, scale: 1, mode: 'number' }),
    ratingCount: integer(),
    attributes: jsonb().$type<Record<string, Provenance>>().notNull().default({}),
    dataQuality: smallint(),
    mergedIntoId: uuid().references((): AnyPgColumn => businesses.id, { onDelete: 'restrict' }),
    version: integer().notNull().default(0),
    firstSeenAt: tz().notNull().defaultNow(),
    lastSeenAt: tz().notNull().defaultNow(),
    ...timestamps(),
  },
  (table) => [
    index('idx_businesses__location').using('gist', table.location),
    index('idx_businesses__normalized_name').using('gin', table.normalizedName.op('gin_trgm_ops')),
    index('idx_businesses__website_registrable_domain').on(table.websiteRegistrableDomain),
    // Shared-host sites (`*.wixsite.com`) have no registrable domain to match on: BF-016 matches the host.
    index('idx_businesses__website_host').on(table.websiteHost),
    index('idx_businesses__primary_phone_e164').on(table.primaryPhoneE164),
    index('idx_businesses__country_code').on(table.countryCode),
    index('idx_businesses__locality').on(table.locality),
    index('idx_businesses__primary_category_id').on(table.primaryCategoryId),
    index('idx_businesses__merged_into_id')
      .on(table.mergedIntoId)
      .where(sql`${table.mergedIntoId} IS NOT NULL`),
    check(
      'ck_businesses__operating_status',
      sql`${table.operatingStatus} IN (${inList(OPERATING_STATUSES)})`,
    ),
    check('ck_businesses__price_level', sql`${table.priceLevel} BETWEEN 0 AND 4`),
    check('ck_businesses__rating_avg', sql`${table.ratingAvg} BETWEEN 0 AND 5`),
    check('ck_businesses__rating_count', sql`${table.ratingCount} >= 0`),
    check('ck_businesses__data_quality', sql`${table.dataQuality} BETWEEN 0 AND 100`),
    check('ck_businesses__country_code', sql`${table.countryCode} ~ '^[A-Z]{2}$'`),
    check('ck_businesses__version', sql`${table.version} >= 0`),
    check('ck_businesses__not_merged_into_self', sql`${table.mergedIntoId} <> ${table.id}`),
  ],
);

/**
 * One row per provider record. `business_id` is null until entity resolution (BF-016) links it; `payload` is the
 * provider's raw (untrusted) data, `normalized` the parsed `SourceRecord`.
 */
export const businessSources = pgTable(
  'business_sources',
  {
    id: id(),
    businessId: uuid().references(() => businesses.id, { onDelete: 'set null' }),
    provider: text().$type<SourceProvider>().notNull(),
    providerRef: text().notNull(),
    payload: jsonb().$type<unknown>().notNull(),
    normalized: jsonb().$type<Record<string, unknown>>(),
    contentHash: text().notNull(),
    fetchedAt: tz().notNull(),
    /** Provider terms limit how long raw data may be kept (ADR-0013). */
    expiresAt: tz(),
    matchConfidence: real(),
    linkedBy: text().$type<'auto' | 'manual'>().notNull().default('auto'),
    /** The workspace that entered a `manual` record (ADR-0008 attribution); never exposed to other workspaces. */
    submittedByOrgId: uuid().references(() => organization.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('uq_business_sources__provider_provider_ref').on(table.provider, table.providerRef),
    index('idx_business_sources__business_id').on(table.businessId),
    index('idx_business_sources__expires_at').on(table.expiresAt).where(sql`${table.expiresAt} IS NOT NULL`),
    check('ck_business_sources__provider', sql`${table.provider} IN (${inList(SOURCE_PROVIDERS)})`),
    check('ck_business_sources__linked_by', sql`${table.linkedBy} IN ('auto', 'manual')`),
    check('ck_business_sources__match_confidence', sql`${table.matchConfidence} BETWEEN 0 AND 1`),
  ],
);

/** Contact points. `person_name` only when the business publishes it itself (security.md §7). */
export const businessContacts = pgTable(
  'business_contacts',
  {
    id: id(),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    type: text().$type<ContactType>().notNull(),
    value: text().notNull(),
    /** E.164 for phones, lowercase address for emails, canonical URL otherwise. */
    normalizedValue: citext().notNull(),
    subtype: text().notNull().default('unknown'),
    personName: text(),
    source: text().$type<SourceProvider>().notNull(),
    sourceUrl: text(),
    publishedOnSite: boolean().notNull().default(false),
    confidence: real().notNull(),
    /** The workspace that added a `manual` contact (ADR-0008 attribution); never exposed to other workspaces. */
    submittedByOrgId: uuid().references(() => organization.id, { onDelete: 'set null' }),
    verificationStatus: text().$type<(typeof VERIFICATION_STATUSES)[number]>().notNull().default('unknown'),
    verifiedAt: tz(),
    firstSeenAt: tz().notNull().defaultNow(),
    lastSeenAt: tz().notNull().defaultNow(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('uq_business_contacts__business_id_type_normalized_value').on(
      table.businessId,
      table.type,
      table.normalizedValue,
    ),
    // Entity resolution looks businesses up by a shared phone or email.
    index('idx_business_contacts__type_normalized_value').on(table.type, table.normalizedValue),
    check('ck_business_contacts__source', sql`${table.source} IN (${inList(SOURCE_PROVIDERS)})`),
    check('ck_business_contacts__type', sql`${table.type} IN (${inList(CONTACT_TYPES)})`),
    check(
      'ck_business_contacts__verification_status',
      sql`${table.verificationStatus} IN (${inList(VERIFICATION_STATUSES)})`,
    ),
    check('ck_business_contacts__confidence', sql`${table.confidence} BETWEEN 0 AND 1`),
  ],
);

export const businessCategories = pgTable(
  'business_categories',
  {
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    categoryId: uuid()
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    isPrimary: boolean().notNull().default(false),
    confidence: real().notNull(),
    source: text().notNull(),
    ...timestamps(),
  },
  (table) => [
    primaryKey({ columns: [table.businessId, table.categoryId] }),
    uniqueIndex('uq_business_categories__business_id_primary')
      .on(table.businessId)
      .where(sql`${table.isPrimary}`),
    index('idx_business_categories__category_id').on(table.categoryId),
    check('ck_business_categories__confidence', sql`${table.confidence} BETWEEN 0 AND 1`),
  ],
);

/** Opening intervals; several per weekday allowed (split shifts); `closes_at < opens_at` means past midnight. */
export const businessHours = pgTable(
  'business_hours',
  {
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    /** 0 = Monday. */
    weekday: smallint().notNull(),
    opensAt: time().notNull(),
    closesAt: time().notNull(),
    source: text().$type<SourceProvider>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.businessId, table.weekday, table.opensAt] }),
    check('ck_business_hours__source', sql`${table.source} IN (${inList(SOURCE_PROVIDERS)})`),
    check('ck_business_hours__weekday', sql`${table.weekday} BETWEEN 0 AND 6`),
  ],
);

export const businessMedia = pgTable(
  'business_media',
  {
    id: id(),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    kind: text().$type<(typeof MEDIA_KINDS)[number]>().notNull(),
    storageKey: text(),
    externalUrl: text(),
    source: text().$type<SourceProvider>().notNull(),
    license: text().$type<(typeof MEDIA_LICENSES)[number]>().notNull().default('unknown'),
    width: integer(),
    height: integer(),
    dominantColors: jsonb().$type<string[]>(),
    altText: jsonb().$type<LocalizedText>(),
    createdAt: tz().notNull().defaultNow(),
  },
  (table) => [
    index('idx_business_media__business_id').on(table.businessId),
    check('ck_business_media__source', sql`${table.source} IN (${inList(SOURCE_PROVIDERS)})`),
    check('ck_business_media__kind', sql`${table.kind} IN (${inList(MEDIA_KINDS)})`),
    check('ck_business_media__license', sql`${table.license} IN (${inList(MEDIA_LICENSES)})`),
    check(
      'ck_business_media__location',
      sql`${table.storageKey} IS NOT NULL OR ${table.externalUrl} IS NOT NULL`,
    ),
    check('ck_business_media__dimensions', sql`${table.width} > 0 AND ${table.height} > 0`),
  ],
);

/** Reviews without reviewer identities (data minimization, security.md §7). */
export const businessReviews = pgTable(
  'business_reviews',
  {
    id: id(),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    source: text().$type<SourceProvider>().notNull(),
    externalId: text(),
    rating: smallint(),
    text: text(),
    language: text(),
    publishedAt: tz(),
    hasOwnerResponse: boolean().notNull().default(false),
    ownerRespondedAt: tz(),
    expiresAt: tz(),
    createdAt: tz().notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_business_reviews__source_external_id').on(table.source, table.externalId),
    index('idx_business_reviews__business_id_published_at').on(table.businessId, table.publishedAt.desc()),
    check('ck_business_reviews__source', sql`${table.source} IN (${inList(SOURCE_PROVIDERS)})`),
    check('ck_business_reviews__rating', sql`${table.rating} BETWEEN 1 AND 5`),
  ],
);

/** Candidate pairs from entity resolution (BF-016); stored once per pair with `business_a_id < business_b_id`. */
export const possibleDuplicates = pgTable(
  'possible_duplicates',
  {
    id: id(),
    businessAId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    businessBId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    score: real().notNull(),
    reasons: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    status: text().$type<(typeof DUPLICATE_STATUS_VALUES)[number]>().notNull().default('open'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('uq_possible_duplicates__business_a_id_business_b_id').on(
      table.businessAId,
      table.businessBId,
    ),
    index('idx_possible_duplicates__business_b_id').on(table.businessBId),
    index('idx_possible_duplicates__open').on(table.createdAt).where(sql`${table.status} = 'open'`),
    check('ck_possible_duplicates__ordered_pair', sql`${table.businessAId} < ${table.businessBId}`),
    check('ck_possible_duplicates__status', sql`${table.status} IN (${inList(DUPLICATE_STATUS_VALUES)})`),
    check('ck_possible_duplicates__score', sql`${table.score} BETWEEN 0 AND 1`),
  ],
);
