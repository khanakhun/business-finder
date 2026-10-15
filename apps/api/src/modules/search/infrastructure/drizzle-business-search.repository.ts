import type { BusinessFacets, BusinessListItem } from '@bf/contracts';
import { type DbClient, getExecutor, runInTransaction } from '@bf/db';
import { businessCategories, businessContacts, businesses, categories, orgBusinesses } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { eq, type SQL, sql } from 'drizzle-orm';
import { APP_ENV, type AppEnv } from '../../platform/config/app-env.ts';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { BusinessSearchRepository, ListingRow } from '../application/listing-ports.ts';
import type { FacetDimension, ListingPosition, ListingSort, ListingSpec } from '../domain/listing.ts';
import {
  arrayOf,
  filterSql,
  keysetSql,
  orderSql,
  point,
  sortKeySql,
  tsQuery,
} from './sql/business-search.sql.ts';

const EMBEDDING_DIMENSIONS = 1536;

const itemColumns = (origin: ListingSpec['origin']) => ({
  id: businesses.id,
  displayName: businesses.displayName,
  primaryCategoryId: businesses.primaryCategoryId,
  operatingStatus: businesses.operatingStatus,
  websiteUrl: businesses.websiteUrl,
  primaryPhone: businesses.primaryPhoneE164,
  locality: businesses.locality,
  countryCode: businesses.countryCode,
  location: businesses.location,
  ratingAvg: businesses.ratingAvg,
  ratingCount: businesses.ratingCount,
  pipelineStatus: orgBusinesses.pipelineStatus,
  score: orgBusinesses.score,
  tier: orgBusinesses.tier,
  tags: orgBusinesses.tags,
  ownerUserId: orgBusinesses.ownerUserId,
  trackedAt: orgBusinesses.createdAt,
  lastActivityAt: orgBusinesses.lastActivityAt,
  distanceMeters: origin
    ? sql<number | null>`ST_Distance(${businesses.location}, ${point(origin)})::float8`
    : sql<null>`NULL`,
});

interface ItemRow extends Omit<BusinessListItem, 'id' | 'trackedAt' | 'lastActivityAt' | 'distanceMeters'> {
  readonly id: string;
  readonly trackedAt: Date;
  readonly lastActivityAt: Date | null;
  readonly distanceMeters: number | null;
}

const toItem = (row: ItemRow): BusinessListItem => ({
  ...row,
  id: row.id as BusinessListItem['id'],
  trackedAt: row.trackedAt.toISOString(),
  lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
  distanceMeters: row.distanceMeters === null ? null : Math.round(row.distanceMeters),
});

const RATING_BAND = sql<string>`CASE
  WHEN ${businesses.ratingAvg} IS NULL THEN 'none'
  WHEN ${businesses.ratingAvg} < 3 THEN 'lt3'
  WHEN ${businesses.ratingAvg} < 4 THEN '3to4'
  WHEN ${businesses.ratingAvg} < 4.5 THEN '4to4.5'
  ELSE 'gte4.5' END`;

@Injectable()
export class DrizzleBusinessSearchRepository implements BusinessSearchRepository {
  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async page(
    spec: ListingSpec,
    sort: ListingSort,
    after: ListingPosition | null,
    limit: number,
  ): Promise<ListingRow[]> {
    const key = sortKeySql(sort, spec.origin);
    const rows = await getExecutor(this.db)
      .select({ ...itemColumns(spec.origin), cursorValue: key.cursorValue })
      .from(orgBusinesses)
      .innerJoin(businesses, eq(businesses.id, orgBusinesses.businessId))
      .where(after ? sql`${filterSql(spec)} AND ${keysetSql(key, sort, after)}` : filterSql(spec))
      .orderBy(orderSql(key, sort))
      .limit(limit);
    return rows.map(({ cursorValue, ...row }) => ({
      item: toItem(row),
      cursorValue: (cursorValue as string | number | null) ?? null,
    }));
  }

  async byIds(spec: ListingSpec, ids: readonly string[]): Promise<BusinessListItem[]> {
    if (ids.length === 0) return [];
    const rows = await getExecutor(this.db)
      .select(itemColumns(spec.origin))
      .from(orgBusinesses)
      .innerJoin(businesses, eq(businesses.id, orgBusinesses.businessId))
      .where(sql`${filterSql(spec)} AND ${businesses.id} = ANY(${arrayOf(ids, 'uuid')})`);
    return rows.map(toItem);
  }

  async rankFullText(spec: ListingSpec, q: string, limit: number): Promise<string[]> {
    const query = tsQuery(q);
    const rows = await getExecutor(this.db)
      .select({ id: businesses.id })
      .from(orgBusinesses)
      .innerJoin(businesses, eq(businesses.id, orgBusinesses.businessId))
      .where(sql`${filterSql(spec)} AND ${businesses.searchTsv} @@ ${query}`)
      .orderBy(sql`ts_rank_cd(${businesses.searchTsv}, ${query}) DESC, ${businesses.id}`)
      .limit(limit);
    return rows.map((r) => r.id);
  }

  async rankTrigram(spec: ListingSpec, q: string, limit: number): Promise<string[]> {
    // Word similarity: "lulu" finds "Chez Lulu"; `<%` uses the trigram GIN index on normalized_name.
    const text = sql`f_unaccent(lower(${q}))`;
    const rows = await getExecutor(this.db)
      .select({ id: businesses.id })
      .from(orgBusinesses)
      .innerJoin(businesses, eq(businesses.id, orgBusinesses.businessId))
      .where(sql`${filterSql(spec)} AND ${text} <% ${businesses.normalizedName}`)
      .orderBy(sql`word_similarity(${text}, ${businesses.normalizedName}) DESC, ${businesses.id}`)
      .limit(limit);
    return rows.map((r) => r.id);
  }

  async rankVector(spec: ListingSpec, vector: readonly number[], limit: number): Promise<string[]> {
    if (vector.length !== EMBEDDING_DIMENSIONS || !vector.every(Number.isFinite)) {
      throw new Error(`Query embedding must have ${EMBEDDING_DIMENSIONS} finite dimensions`);
    }
    const literal = sql`${`[${vector.join(',')}]`}::vector`;
    const efSearch = Math.trunc(this.env.SEARCH_HNSW_EF_SEARCH);
    return runInTransaction(this.db, async (tx) => {
      // Filtered HNSW scans can run out of candidates; iterative scans keep going (pgvector ≥ 0.8). Relaxed order
      // is re-sorted below.
      await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${efSearch}`));
      await tx.execute(sql`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`);
      const rows = (await tx.execute(sql`
        WITH nearest AS MATERIALIZED (
          SELECT ${businesses.id} AS id, ${businesses.embedding} <=> ${literal} AS distance
          FROM ${orgBusinesses} JOIN ${businesses} ON ${businesses.id} = ${orgBusinesses.businessId}
          WHERE ${filterSql(spec)} AND ${businesses.embedding} IS NOT NULL
          ORDER BY distance
          LIMIT ${limit}
        )
        SELECT id FROM nearest WHERE distance <= ${this.env.SEARCH_VECTOR_MAX_DISTANCE}
        ORDER BY distance, id`)) as unknown as Array<{ id: string }>;
      return rows.map((r) => r.id);
    });
  }

  async facets(spec: ListingSpec, within: readonly string[] | null): Promise<BusinessFacets> {
    const where = (omit?: FacetDimension): SQL =>
      within
        ? sql`${filterSql(spec, omit)} AND ${businesses.id} = ANY(${arrayOf(within, 'uuid')})`
        : filterSql(spec, omit);
    const counts = async (dimension: FacetDimension, value: SQL, extra?: { order: SQL; limit: number }) => {
      const rows = await getExecutor(this.db)
        .select({ value: sql<string>`${value}`, count: sql<number>`count(*)::int` })
        .from(orgBusinesses)
        .innerJoin(businesses, eq(businesses.id, orgBusinesses.businessId))
        .where(where(dimension))
        .groupBy(sql`1`)
        .orderBy(extra?.order ?? sql`2 DESC, 1`)
        .limit(extra?.limit ?? 50);
      return rows.filter((r) => r.value !== null);
    };
    const hasEmail = sql`EXISTS (SELECT 1 FROM ${businessContacts} bc WHERE bc.business_id = ${businesses.id} AND bc.type = 'email')`;
    const [total, categoryCounts, pipelineStatuses, tiers, website, email, ratingBands, localities] =
      await Promise.all([
        getExecutor(this.db)
          .select({ n: sql<number>`count(*)::int` })
          .from(orgBusinesses)
          .innerJoin(businesses, eq(businesses.id, orgBusinesses.businessId))
          .where(where())
          .then((rows) => rows[0]?.n ?? 0),
        this.categoryFacet(spec, where('category')),
        counts('status', sql`${orgBusinesses.pipelineStatus}`),
        counts('tier', sql`coalesce(${orgBusinesses.tier}, 'none')`),
        counts('website', sql`CASE WHEN ${businesses.websiteUrl} IS NULL THEN 'none' ELSE 'has' END`),
        counts('email', sql`CASE WHEN ${hasEmail} THEN 'has' ELSE 'none' END`),
        counts('rating', RATING_BAND),
        counts('locality', sql`${businesses.locality}`, { order: sql`2 DESC, 1`, limit: 21 }),
      ]);
    return {
      total,
      categories: categoryCounts,
      pipelineStatuses,
      tiers,
      website,
      email,
      ratingBands,
      localities: localities.slice(0, 20),
    };
  }

  /** Top-level categories plus the children of selected ones, each counting its whole subtree. */
  private async categoryFacet(spec: ListingSpec, where: SQL): Promise<BusinessFacets['categories']> {
    const selected = spec.filters.category ?? [];
    const rows = (await getExecutor(this.db).execute(sql`
      WITH matching AS (
        SELECT ${businesses.id} AS id
        FROM ${orgBusinesses} JOIN ${businesses} ON ${businesses.id} = ${orgBusinesses.businessId}
        WHERE ${where}
      ),
      facet AS (
        SELECT id, slug, labels, parent_id, path FROM ${categories}
        WHERE is_active AND (nlevel(path) = 1${
          selected.length > 0 ? sql` OR parent_id = ANY(${arrayOf(selected, 'uuid')})` : sql``
        })
      )
      SELECT facet.id, facet.slug, facet.labels, facet.parent_id AS "parentId", count(DISTINCT matching.id)::int AS count
      FROM facet
      JOIN ${categories} sub ON sub.path <@ facet.path
      JOIN ${businessCategories} bcat ON bcat.category_id = sub.id
      JOIN matching ON matching.id = bcat.business_id
      GROUP BY facet.id, facet.slug, facet.labels, facet.parent_id
      ORDER BY count DESC, facet.slug`)) as unknown as BusinessFacets['categories'];
    return rows;
  }
}
