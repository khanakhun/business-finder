import { and, eq, ne, notInArray, sql } from 'drizzle-orm';
import { appMeta, categories, categoryMappings } from '../../schema/index.ts';
import type { DbExecutor } from '../../tx.ts';
import type { SeedModule } from '../runner.ts';
import { loadTaxonomy, type Taxonomy } from '../taxonomy/load.ts';

export const TAXONOMY_VERSION_KEY = 'taxonomy_version';

export interface TaxonomySeedResult {
  readonly categoriesWritten: number;
  readonly categoriesDeactivated: number;
  readonly mappingsWritten: number;
  readonly mappingsRetired: number;
}

const distinct = (column: string) => sql.raw(`categories.${column} IS DISTINCT FROM excluded.${column}`);

/**
 * Upserts the taxonomy and seed mappings. Idempotent: unchanged rows are not touched (so `updated_at` and
 * embeddings stay put). Categories missing from the file are deactivated, never deleted (slugs are stable).
 * `human` mappings are never overwritten; seed rows dropped from the files are retired (`rejected`).
 */
export async function seedTaxonomy(tx: DbExecutor, taxonomy: Taxonomy): Promise<TaxonomySeedResult> {
  const ids = new Map<string, string>();
  let categoriesWritten = 0;
  for (const category of taxonomy.categories) {
    const parentId = category.parentSlug ? ids.get(category.parentSlug) : null;
    if (parentId === undefined) throw new Error(`Parent of ${category.slug} not seeded`);
    const values = {
      slug: category.slug,
      parentId,
      path: category.path,
      labels: category.labels,
      synonyms: category.synonyms,
      description: category.description,
      icon: category.icon,
      attributes: category.attributes,
      offerRelevance: category.offerRelevance,
      sortOrder: category.sortOrder,
      isActive: true,
    };
    const [written] = await tx
      .insert(categories)
      .values(values)
      .onConflictDoUpdate({
        target: categories.slug,
        set: {
          parentId: sql`excluded.parent_id`,
          path: sql`excluded.path`,
          labels: sql`excluded.labels`,
          synonyms: sql`excluded.synonyms`,
          description: sql`excluded.description`,
          icon: sql`excluded.icon`,
          attributes: sql`excluded.attributes`,
          offerRelevance: sql`excluded.offer_relevance`,
          sortOrder: sql`excluded.sort_order`,
          isActive: sql`true`,
        },
        setWhere: sql.join(
          [
            'parent_id',
            'path',
            'labels',
            'synonyms',
            'description',
            'icon',
            'attributes',
            'offer_relevance',
            'sort_order',
            'is_active',
          ].map(distinct),
          sql` OR `,
        ),
      })
      .returning({ id: categories.id });
    if (written) {
      categoriesWritten++;
      ids.set(category.slug, written.id);
    } else {
      const [existing] = await tx
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.slug, category.slug));
      if (!existing) throw new Error(`Category ${category.slug} missing after upsert`);
      ids.set(category.slug, existing.id);
    }
  }
  const deactivated = await tx
    .update(categories)
    .set({ isActive: false })
    .where(and(eq(categories.isActive, true), notInArray(categories.slug, [...ids.keys()])))
    .returning({ id: categories.id });

  let mappingsWritten = 0;
  for (const mapping of taxonomy.mappings) {
    const categoryId = ids.get(mapping.category) as string;
    const written = await tx
      .insert(categoryMappings)
      .values({
        provider: mapping.provider,
        providerKey: mapping.key,
        providerLabel: mapping.label,
        categoryId,
        confidence: mapping.confidence,
        origin: 'seed',
        status: 'active',
        seedVersion: taxonomy.version,
      })
      .onConflictDoUpdate({
        target: [categoryMappings.provider, categoryMappings.providerKey],
        set: {
          providerLabel: sql`excluded.provider_label`,
          categoryId: sql`excluded.category_id`,
          confidence: sql`excluded.confidence`,
          origin: sql`excluded.origin`,
          status: sql`excluded.status`,
          rationale: sql`NULL`,
          seedVersion: sql`excluded.seed_version`,
        },
        // Reviewers' decisions win over files; unchanged seed rows are left alone.
        setWhere: sql`category_mappings.origin <> 'human' AND (
          category_mappings.origin <> 'seed' OR category_mappings.status <> 'active'
          OR category_mappings.category_id <> excluded.category_id
          OR category_mappings.confidence <> excluded.confidence
          OR category_mappings.provider_label IS DISTINCT FROM excluded.provider_label
          OR category_mappings.seed_version IS DISTINCT FROM excluded.seed_version)`,
      })
      .returning({ id: categoryMappings.id });
    mappingsWritten += written.length;
  }
  const current = taxonomy.mappings.map((m) => `${m.provider}:${m.key}`);
  const retired = await tx
    .update(categoryMappings)
    .set({ status: 'rejected' })
    .where(
      and(
        eq(categoryMappings.origin, 'seed'),
        ne(categoryMappings.status, 'rejected'),
        current.length > 0
          ? notInArray(sql`${categoryMappings.provider} || ':' || ${categoryMappings.providerKey}`, current)
          : undefined,
      ),
    )
    .returning({ id: categoryMappings.id });

  await tx
    .insert(appMeta)
    .values({ key: TAXONOMY_VERSION_KEY, value: { version: taxonomy.version } })
    .onConflictDoUpdate({
      target: appMeta.key,
      set: { value: sql`excluded.value`, updatedAt: sql`now()` },
      setWhere: sql`app_meta.value IS DISTINCT FROM excluded.value`,
    });

  return {
    categoriesWritten,
    categoriesDeactivated: deactivated.length,
    mappingsWritten,
    mappingsRetired: retired.length,
  };
}

/** Reference data needed in every environment (production runs the `staging` seed set). */
export const taxonomySeedModule: SeedModule = {
  name: 'taxonomy',
  environments: ['dev', 'test', 'staging'],
  async run(tx) {
    await seedTaxonomy(tx, loadTaxonomy());
  },
};
