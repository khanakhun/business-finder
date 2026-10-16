import { type DbClient, getExecutor } from '@bf/db';
import { appMeta, categories, categoryMappings } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';
import type {
  CategoryRecord,
  EmbeddingTarget,
  MappingRecord,
  ScoredSlug,
  TaxonomyRepository,
} from '../../application/taxonomy/ports.ts';

const toMapping = (row: typeof categoryMappings.$inferSelect): MappingRecord => ({
  id: row.id,
  provider: row.provider,
  providerKey: row.providerKey,
  providerLabel: row.providerLabel,
  categoryId: row.categoryId,
  confidence: row.confidence,
  origin: row.origin,
  status: row.status,
  rationale: row.rationale,
  createdAt: row.createdAt,
  reviewedAt: row.reviewedAt,
});

/** What gets embedded for a category: both languages' labels and synonyms. */
export const embeddingTextOf = (row: {
  readonly labels: { en: string; fr: string };
  readonly synonyms: { en: string[]; fr: string[] };
}) => [row.labels.en, row.labels.fr, ...row.synonyms.en, ...row.synonyms.fr].join(' | ');

/** Microsecond-precision text of `created_at` for keyset cursors (see the businesses read model). */
const createdAtText = sql<string>`to_char(${categoryMappings.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

@Injectable()
export class DrizzleTaxonomyRepository implements TaxonomyRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async loadActive() {
    const executor = getExecutor(this.db);
    const [categoryRows, mappingRows] = await Promise.all([
      executor
        .select({
          id: categories.id,
          slug: categories.slug,
          parentId: categories.parentId,
          path: categories.path,
          labels: categories.labels,
          synonyms: categories.synonyms,
          icon: categories.icon,
          attributes: categories.attributes,
          offerRelevance: categories.offerRelevance,
          sortOrder: categories.sortOrder,
        })
        .from(categories)
        .where(eq(categories.isActive, true))
        .orderBy(sql`nlevel(${categories.path})`, asc(categories.sortOrder), asc(categories.slug)),
      executor
        .select({ mapping: categoryMappings })
        .from(categoryMappings)
        .innerJoin(categories, eq(categories.id, categoryMappings.categoryId))
        .where(and(eq(categoryMappings.status, 'active'), eq(categories.isActive, true))),
    ]);
    return {
      categories: categoryRows satisfies CategoryRecord[],
      mappings: mappingRows.map((row) => toMapping(row.mapping)),
    };
  }

  async trigramSearch(text: string, limit: number): Promise<ScoredSlug[]> {
    const query = sql`f_unaccent(lower(${text}))`;
    const score = sql<number>`word_similarity(${query}, ${categories.searchText})`;
    const rows = await getExecutor(this.db)
      .select({ slug: categories.slug, score })
      .from(categories)
      // `<%` uses the trigram index (word_similarity ≥ pg_trgm.word_similarity_threshold, 0.6 by default).
      .where(
        and(eq(categories.isActive, true), sql`(${query} <% ${categories.searchText} OR ${score} > 0.3)`),
      )
      .orderBy(desc(score), asc(categories.slug))
      .limit(limit);
    return rows;
  }

  async vectorSearch(vector: readonly number[], model: string, limit: number): Promise<ScoredSlug[]> {
    const literal = `[${vector.join(',')}]`;
    const distance = sql<number>`${categories.embedding} <=> ${literal}::vector`;
    const rows = await getExecutor(this.db)
      .select({ slug: categories.slug, distance })
      .from(categories)
      .where(
        and(
          eq(categories.isActive, true),
          eq(categories.embeddingModel, model),
          isNotNull(categories.embedding),
        ),
      )
      .orderBy(distance)
      .limit(limit);
    return rows.map((row) => ({ slug: row.slug, score: 1 - Number(row.distance) }));
  }

  async hasEmbeddings(model: string): Promise<boolean> {
    const [row] = await getExecutor(this.db)
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.isActive, true),
          eq(categories.embeddingModel, model),
          isNotNull(categories.embedding),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async listEmbeddingTargets(): Promise<EmbeddingTarget[]> {
    const rows = await getExecutor(this.db)
      .select({
        id: categories.id,
        slug: categories.slug,
        labels: categories.labels,
        synonyms: categories.synonyms,
        embeddingModel: categories.embeddingModel,
        embeddingTextHash: categories.embeddingTextHash,
      })
      .from(categories)
      .where(eq(categories.isActive, true))
      .orderBy(asc(categories.slug));
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      text: embeddingTextOf(row),
      embeddingModel: row.embeddingModel,
      embeddingTextHash: row.embeddingTextHash,
    }));
  }

  async saveEmbedding(id: string, vector: readonly number[], model: string, textHash: string): Promise<void> {
    await getExecutor(this.db)
      .update(categories)
      .set({ embedding: [...vector], embeddingModel: model, embeddingTextHash: textHash })
      .where(eq(categories.id, id));
  }

  async insertLearnedMapping(
    input: Parameters<TaxonomyRepository['insertLearnedMapping']>[0],
  ): Promise<boolean> {
    const rows = await getExecutor(this.db)
      .insert(categoryMappings)
      .values({ ...input, origin: 'llm', status: 'needs_review' })
      .onConflictDoNothing({ target: [categoryMappings.provider, categoryMappings.providerKey] })
      .returning({ id: categoryMappings.id });
    return rows.length > 0;
  }

  async listMappings(filter: Parameters<TaxonomyRepository['listMappings']>[0]) {
    const rows = await getExecutor(this.db)
      .select({ mapping: categoryMappings, createdAtText })
      .from(categoryMappings)
      .where(
        and(
          eq(categoryMappings.status, filter.status),
          filter.provider ? eq(categoryMappings.provider, filter.provider) : undefined,
          filter.before
            ? sql`(${categoryMappings.createdAt}, ${categoryMappings.id}) < (${filter.before.createdAt}::timestamptz, ${filter.before.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(categoryMappings.createdAt), desc(categoryMappings.id))
      .limit(filter.limit);
    return rows.map((row) => ({ ...toMapping(row.mapping), createdAtText: row.createdAtText }));
  }

  async getMapping(id: string): Promise<MappingRecord | undefined> {
    const [row] = await getExecutor(this.db)
      .select()
      .from(categoryMappings)
      .where(eq(categoryMappings.id, id));
    return row ? toMapping(row) : undefined;
  }

  async reviewMapping(
    id: string,
    change: Parameters<TaxonomyRepository['reviewMapping']>[1],
  ): Promise<MappingRecord | undefined> {
    const [row] = await getExecutor(this.db)
      .update(categoryMappings)
      .set({
        status: change.status,
        categoryId: change.categoryId,
        confidence: change.confidence,
        // A reviewer's decision outranks seeds and the model, and seeds never overwrite it.
        origin: 'human',
        reviewedBy: change.reviewedBy,
        reviewedAt: sql`now()`,
      })
      .where(eq(categoryMappings.id, id))
      .returning();
    return row ? toMapping(row) : undefined;
  }

  async taxonomyVersion(): Promise<number> {
    const [row] = await getExecutor(this.db)
      .select()
      .from(appMeta)
      .where(eq(appMeta.key, 'taxonomy_version'));
    const version = (row?.value as { version?: unknown } | undefined)?.version;
    return typeof version === 'number' ? version : 0;
  }
}
