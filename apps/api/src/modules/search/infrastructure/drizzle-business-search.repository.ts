import type { BusinessFacets, BusinessListItem } from '@bf/contracts';
import { type DbClient, getExecutor, runInTransaction } from '@bf/db';
import { businessCategories, businessContacts, businesses, categories, orgBusinesses } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { eq, type SQL, sql } from 'drizzle-orm';
import { APP_ENV, type AppEnv } from '../../platform/config/app-env.ts';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { BusinessSearchRepository, ExportExtras, ListingRow } from '../application/listing-ports.ts';
import type { FacetDimension, ListingPosition, ListingSort, ListingSpec } from '../domain/listing.ts';
import {
  arrayOf,
  dimensionSql,
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

const FLAGS: readonly FacetDimension[] = ['category', 'status', 'tier', 'website', 'email', 'rating'];

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
    const rows = await this.pageQuery(spec, sort, after, limit);
    return rows.map(({ cursorValue, ...row }) => ({
      item: toItem(row),
      cursorValue: (cursorValue as string | number | null) ?? null,
    }));
  }

  // Query builders are public so the EXPLAIN tests check the plans of exactly what runs (BF-022).

  pageQuery(spec: ListingSpec, sort: ListingSort, after: ListingPosition | null, limit: number) {
    const key = sortKeySql(sort, spec.origin);
    return getExecutor(this.db)
      .select({ ...itemColumns(spec.origin), cursorValue: key.cursorValue })
      .from(orgBusinesses)
      .innerJoin(businesses, eq(businesses.id, orgBusinesses.businessId))
      .where(after ? sql`${filterSql(spec)} AND ${keysetSql(key, sort, after)}` : filterSql(spec))
      .orderBy(orderSql(key, sort))
      .limit(limit);
  }

  fullTextQuery(spec: ListingSpec, q: string, limit: number) {
    const query = tsQuery(q);
    return getExecutor(this.db)
      .select({ id: businesses.id })
      .from(orgBusinesses)
      .innerJoin(businesses, eq(businesses.id, orgBusinesses.businessId))
      .where(sql`${filterSql(spec)} AND ${businesses.searchTsv} @@ ${query}`)
      .orderBy(sql`ts_rank_cd(${businesses.searchTsv}, ${query}) DESC, ${businesses.id}`)
      .limit(limit);
  }

  /** Word similarity: "lulu" finds "Chez Lulu"; `<%` uses the trigram GIN index on normalized_name. */
  trigramQuery(spec: ListingSpec, q: string, limit: number) {
    const text = sql`f_unaccent(lower(${q}))`;
    return getExecutor(this.db)
      .select({ id: businesses.id })
      .from(orgBusinesses)
      .innerJoin(businesses, eq(businesses.id, orgBusinesses.businessId))
      .where(sql`${filterSql(spec)} AND ${text} <% ${businesses.normalizedName}`)
      .orderBy(sql`word_similarity(${text}, ${businesses.normalizedName}) DESC, ${businesses.id}`)
      .limit(limit);
  }

  /** Nearest vectors of the configured model (run with the session settings `rankVector` sets). */
  vectorQuery(spec: ListingSpec, vector: readonly number[], limit: number): SQL {
    if (vector.length !== EMBEDDING_DIMENSIONS || !vector.every(Number.isFinite)) {
      throw new Error(`Query embedding must have ${EMBEDDING_DIMENSIONS} finite dimensions`);
    }
    const literal = sql`${`[${vector.join(',')}]`}::vector`;
    return sql`
        WITH nearest AS MATERIALIZED (
          SELECT ${businesses.id} AS id, ${businesses.embedding} <=> ${literal} AS distance
          FROM ${orgBusinesses} JOIN ${businesses} ON ${businesses.id} = ${orgBusinesses.businessId}
          WHERE ${filterSql(spec)} AND ${businesses.embedding} IS NOT NULL
            -- Vectors from another model are not comparable: they wait for pnpm search:reindex.
            AND ${businesses.embeddingModel} = ${this.env.AI_EMBEDDING_MODEL}
          ORDER BY distance
          LIMIT ${limit}
        )
        SELECT id FROM nearest WHERE distance <= ${this.env.SEARCH_VECTOR_MAX_DISTANCE}
        ORDER BY distance, id`;
  }

  /** Session settings for vector ranking (inside a transaction). */
  vectorSettings(): SQL[] {
    return [
      sql.raw(`SET LOCAL hnsw.ef_search = ${Math.trunc(this.env.SEARCH_HNSW_EF_SEARCH)}`),
      // Filtered HNSW scans can run out of candidates; iterative scans keep going (pgvector ≥ 0.8). Relaxed order
      // is re-sorted by the query.
      sql`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`,
    ];
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
    return (await this.fullTextQuery(spec, q, limit)).map((r) => r.id);
  }

  async rankTrigram(spec: ListingSpec, q: string, limit: number): Promise<string[]> {
    return (await this.trigramQuery(spec, q, limit)).map((r) => r.id);
  }

  async rankVector(spec: ListingSpec, vector: readonly number[], limit: number): Promise<string[]> {
    const query = this.vectorQuery(spec, vector, limit);
    return runInTransaction(this.db, async (tx) => {
      for (const setting of this.vectorSettings()) await tx.execute(setting);
      const rows = (await tx.execute(query)) as unknown as Array<{ id: string }>;
      return rows.map((r) => r.id);
    });
  }

  async count(spec: ListingSpec): Promise<number> {
    const [row] = await getExecutor(this.db)
      .select({ n: sql<number>`count(*)::int` })
      .from(orgBusinesses)
      .innerJoin(businesses, eq(businesses.id, orgBusinesses.businessId))
      .where(filterSql(spec));
    return row?.n ?? 0;
  }

  async exportExtras(
    ids: readonly string[],
    options: { readonly lang: 'en' | 'fr'; readonly email: boolean },
  ): Promise<Map<string, ExportExtras>> {
    if (ids.length === 0) return new Map();
    const rows = (await getExecutor(this.db).execute(sql`
      SELECT b.id, c.labels->>${options.lang} AS category, b.formatted_address AS address, b.postal_code AS "postalCode",
        ${
          options.email
            ? sql`(SELECT bc.value FROM ${businessContacts} bc WHERE bc.business_id = b.id AND bc.type = 'email'
                ORDER BY (bc.verification_status = 'valid') DESC, bc.confidence DESC, bc.value LIMIT 1)`
            : sql`NULL`
        } AS email
      FROM ${businesses} b LEFT JOIN ${categories} c ON c.id = b.primary_category_id
      WHERE b.id = ANY(${arrayOf(ids, 'uuid')})`)) as unknown as Array<ExportExtras & { id: string }>;
    return new Map(rows.map(({ id, ...extras }) => [id, extras]));
  }

  /**
   * Every facet in one statement (one snapshot, one scan): the matching rows are computed once with the
   * non-dimension filters, each dimension filter becomes a flag, and each dimension counts the rows passing every
   * flag but its own (GROUPING SETS). Categories roll up through ltree prefixes (top level, and the level below each
   * selected category).
   */
  async facets(spec: ListingSpec, within: readonly string[] | null): Promise<BusinessFacets> {
    const dims = dimensionSql(spec);
    const flag = (d: Exclude<FacetDimension, 'category' | 'locality'>) => dims[d] ?? sql`TRUE`;
    const others = (d: FacetDimension | null) =>
      sql.join(
        FLAGS.filter((f) => f !== d).map((f) => sql.raw(`f_${f}`)),
        sql` AND `,
      );
    const selected = spec.filters.category ?? [];
    // JIT compilation of this large aggregate costs ~0.4 s at 200k rows, more than the query itself.
    const rows = await runInTransaction(this.db, async (tx) => {
      await tx.execute(sql`SET LOCAL jit = off`);
      await tx.execute(sql`SET LOCAL work_mem = '64MB'`);
      return (await tx.execute(sql`
      WITH matching AS MATERIALIZED (
        SELECT ${businesses.id} AS id,
          ${orgBusinesses.pipelineStatus} AS status,
          coalesce(${orgBusinesses.tier}, 'none') AS tier,
          CASE WHEN ${businesses.websiteUrl} IS NULL THEN 'none' ELSE 'has' END AS website,
          CASE WHEN EXISTS (SELECT 1 FROM ${businessContacts} bc WHERE bc.business_id = ${businesses.id} AND bc.type = 'email')
            THEN 'has' ELSE 'none' END AS email,
          ${RATING_BAND} AS rating,
          ${businesses.locality} AS locality,
          ${selected.length > 0 ? sql`in_category.business_id IS NOT NULL` : sql`TRUE`} AS f_category,
          ${flag('status')} AS f_status, ${flag('tier')} AS f_tier,
          ${flag('website')} AS f_website, ${flag('email')} AS f_email, ${flag('rating')} AS f_rating
        FROM ${orgBusinesses} JOIN ${businesses} ON ${businesses.id} = ${orgBusinesses.businessId}
        ${
          // The category flag as one hash join rather than a subquery per row.
          selected.length > 0
            ? sql`LEFT JOIN (
                SELECT DISTINCT bcat.business_id FROM ${businessCategories} bcat JOIN ${categories} c ON c.id = bcat.category_id
                WHERE c.path <@ ARRAY(SELECT sel.path FROM ${categories} sel WHERE sel.id = ANY(${arrayOf(selected, 'uuid')}))
              ) in_category ON in_category.business_id = ${businesses.id}`
            : sql``
        }
        WHERE ${filterSql(spec, 'dimensions')}${within ? sql` AND ${businesses.id} = ANY(${arrayOf(within, 'uuid')})` : sql``}
      ),
      simple AS (
        SELECT
          CASE WHEN GROUPING(status) = 0 THEN 'status' WHEN GROUPING(tier) = 0 THEN 'tier'
            WHEN GROUPING(website) = 0 THEN 'website' WHEN GROUPING(email) = 0 THEN 'email'
            WHEN GROUPING(rating) = 0 THEN 'rating' WHEN GROUPING(locality) = 0 THEN 'locality' ELSE 'total' END AS dim,
          coalesce(status, tier, website, email, rating, locality) AS value,
          CASE WHEN GROUPING(status) = 0 THEN count(*) FILTER (WHERE ${others('status')})
            WHEN GROUPING(tier) = 0 THEN count(*) FILTER (WHERE ${others('tier')})
            WHEN GROUPING(website) = 0 THEN count(*) FILTER (WHERE ${others('website')})
            WHEN GROUPING(email) = 0 THEN count(*) FILTER (WHERE ${others('email')})
            WHEN GROUPING(rating) = 0 THEN count(*) FILTER (WHERE ${others('rating')})
            ELSE count(*) FILTER (WHERE ${others(null)}) END AS n
        FROM matching
        GROUP BY GROUPING SETS ((status), (tier), (website), (email), (rating), (locality), ())
      ),
      category_prefixes AS (
        -- Category → the facet categories it rolls up into (a few hundred rows): its top-level ancestor, and the
        -- child of a selected category it sits under.
        SELECT c.id, subpath(c.path, 0, 1) AS prefix FROM ${categories} c
        ${
          selected.length > 0
            ? sql`UNION ALL
        SELECT c.id, subpath(c.path, 0, nlevel(sel.path) + 1) FROM ${categories} sel
        JOIN ${categories} c ON c.path <@ sel.path AND nlevel(c.path) > nlevel(sel.path)
        WHERE sel.id = ANY(${arrayOf(selected, 'uuid')})`
            : sql``
        }
      ),
      prefixes AS (
        SELECT DISTINCT cp.prefix, m.id
        FROM matching m
        JOIN ${businessCategories} bcat ON bcat.business_id = m.id
        JOIN category_prefixes cp ON cp.id = bcat.category_id
        WHERE ${others('category')}
      ),
      category AS (
        SELECT 'category' AS dim, f.id::text AS value, count(*) AS n
        FROM prefixes JOIN ${categories} f ON f.path = prefixes.prefix
        WHERE f.is_active AND (nlevel(f.path) = 1${
          selected.length > 0 ? sql` OR f.parent_id = ANY(${arrayOf(selected, 'uuid')})` : sql``
        })
        GROUP BY f.id
      )
      SELECT dim, value, n::int AS n FROM simple WHERE n > 0 AND (value IS NOT NULL OR dim = 'total')
      UNION ALL SELECT dim, value, n::int FROM category`)) as unknown as Array<{
        dim: FacetDimension | 'locality' | 'total';
        value: string | null;
        n: number;
      }>;
    });
    const of = (dim: string) =>
      rows
        .filter((r) => r.dim === dim)
        .map((r) => ({ value: r.value as string, count: r.n }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    const categoryCounts = of('category');
    const labels =
      categoryCounts.length === 0
        ? []
        : await getExecutor(this.db)
            .select({
              id: categories.id,
              slug: categories.slug,
              labels: categories.labels,
              parentId: categories.parentId,
            })
            .from(categories)
            .where(
              sql`${categories.id} = ANY(${arrayOf(
                categoryCounts.map((c) => c.value),
                'uuid',
              )})`,
            );
    const byId = new Map(labels.map((c) => [c.id, c]));
    return {
      total: rows.find((r) => r.dim === 'total')?.n ?? 0,
      categories: categoryCounts.flatMap((c) => {
        const category = byId.get(c.value);
        return category ? [{ ...category, count: c.count }] : [];
      }),
      pipelineStatuses: of('status'),
      tiers: of('tier'),
      website: of('website'),
      email: of('email'),
      ratingBands: of('rating'),
      localities: of('locality').slice(0, 20),
    };
  }
}
