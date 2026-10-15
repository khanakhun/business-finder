import type { TaxonomyProvider } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { CategoryProviderKeys } from '../application/ports.ts';
import type { ProviderKey } from '../domain/provider.port.ts';

/**
 * Reverse lookup of category mappings (BF-015): a category's provider keys include its descendants' ("food" asks
 * for restaurants, cafés…), active mappings only, nearest category first then by confidence.
 */
@Injectable()
export class DrizzleCategoryProviderKeys implements CategoryProviderKeys {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async keysFor(
    categoryIds: readonly string[],
    taxonomy: TaxonomyProvider,
  ): Promise<Map<string, ProviderKey[]>> {
    const result = new Map<string, ProviderKey[]>();
    if (categoryIds.length === 0) return result;
    const rows = (await getExecutor(this.db).execute(sql`
      SELECT requested.id AS category_id, m.provider_key, m.provider_label
      FROM categories requested
      JOIN categories c ON c.path <@ requested.path
      JOIN category_mappings m ON m.category_id = c.id
      WHERE requested.id IN (${sql.join(
        [...new Set(categoryIds)].map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
        AND m.provider = ${taxonomy}
        AND m.status = 'active'
      ORDER BY requested.id, nlevel(c.path), m.confidence DESC, m.provider_key`)) as unknown as Array<{
      category_id: string;
      provider_key: string;
      provider_label: string | null;
    }>;
    for (const row of rows) {
      const keys = result.get(row.category_id) ?? [];
      if (!keys.some((k) => k.key === row.provider_key))
        keys.push({ key: row.provider_key, label: row.provider_label });
      result.set(row.category_id, keys);
    }
    return result;
  }
}
