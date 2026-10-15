import { type DbClient, getExecutor } from '@bf/db';
import { businesses } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { eq, type SQL, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { BusinessEmbeddingRepository, EmbeddingSourceRow } from '../application/embedding-ports.ts';
import { arrayOf } from './sql/business-search.sql.ts';

interface SourceSqlRow {
  id: string;
  displayName: string;
  locality: string | null;
  countryCode: string | null;
  shortDescription: string | null;
  priceLevel: number | null;
  embeddingModel: string | null;
  embeddingTextHash: string | null;
  categories: EmbeddingSourceRow['categories'];
}

@Injectable()
export class DrizzleBusinessEmbeddingRepository implements BusinessEmbeddingRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  sources(ids: readonly string[]): Promise<EmbeddingSourceRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.select(sql`b.id = ANY(${arrayOf(ids, 'uuid')})`, sql``);
  }

  sourcesAfter(afterId: string | null, limit: number): Promise<EmbeddingSourceRow[]> {
    return this.select(afterId ? sql`b.id > ${afterId}::uuid` : sql`TRUE`, sql`ORDER BY b.id LIMIT ${limit}`);
  }

  async save(id: string, vector: readonly number[], model: string, textHash: string): Promise<void> {
    await getExecutor(this.db)
      .update(businesses)
      .set({ embedding: [...vector], embeddingModel: model, embeddingTextHash: textHash })
      .where(eq(businesses.id, id));
  }

  /** Each category with its labels from the root down (for "Restaurant > Pizzeria"). */
  private async select(where: SQL, tail: SQL): Promise<EmbeddingSourceRow[]> {
    const rows = (await getExecutor(this.db).execute(sql`
      SELECT b.id, b.display_name AS "displayName", b.locality, b.country_code AS "countryCode",
        b.short_description AS "shortDescription", b.price_level AS "priceLevel",
        b.embedding_model AS "embeddingModel", b.embedding_text_hash AS "embeddingTextHash",
        coalesce((
          SELECT json_agg(json_build_object(
            'slug', c.slug,
            'isPrimary', bc.is_primary,
            'labels', (SELECT json_agg(a.labels ORDER BY nlevel(a.path)) FROM categories a WHERE a.path @> c.path)
          ) ORDER BY c.slug)
          FROM business_categories bc JOIN categories c ON c.id = bc.category_id
          WHERE bc.business_id = b.id
        ), '[]'::json) AS categories
      FROM businesses b
      WHERE b.merged_into_id IS NULL AND ${where}
      ${tail}`)) as unknown as SourceSqlRow[];
    return rows;
  }
}
