import { createIsolatedDatabase, type IsolatedDatabase } from '@bf/testing/db';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createDb, type DbClient } from '../client.ts';
import { appMeta, categories, categoryMappings } from '../schema/index.ts';
import { runInTransaction } from '../tx.ts';
import { seedTaxonomy, TAXONOMY_VERSION_KEY } from './modules/taxonomy.ts';
import { loadTaxonomy, parseTaxonomy, type Taxonomy } from './taxonomy/load.ts';

const TREE = (extra = '') => `
version: 1
categories:
  - slug: shops
    labels: { en: Shops, fr: Commerces }
    children:
      - slug: hardware_store
        labels: { en: Hardware store, fr: Quincaillerie }
        synonyms: { en: [ironmonger], fr: [droguerie] }
      - slug: florist
        labels: { en: Florist, fr: Fleuriste }
${extra}`;
const MAPPINGS = (key = 'hardware_store') => `
provider: google_places
version: 1
mappings:
  - { key: ${key}, category: hardware_store }
  - { key: florist, category: florist }
`;
const taxonomyOf = (tree: string, mappings: string): Taxonomy =>
  parseTaxonomy({ name: 'taxonomy.v1.yaml', text: tree }, [
    { name: 'google_places.v1.yaml', text: mappings },
  ]);

let database: IsolatedDatabase;
let db: DbClient;
const seed = (taxonomy: Taxonomy) => runInTransaction(db, (tx) => seedTaxonomy(tx, taxonomy));

beforeAll(async () => {
  database = await createIsolatedDatabase();
  db = createDb({ url: database.url, max: 2, applicationName: 'bf-int-test' });
});

afterAll(async () => {
  await closeDb(db);
  await database.drop();
});

describe('taxonomy seed', () => {
  it('seeds the tree and mappings, then changes nothing on a second run', async () => {
    const taxonomy = taxonomyOf(TREE(), MAPPINGS());
    expect(await seed(taxonomy)).toEqual({
      categoriesWritten: 3,
      categoriesDeactivated: 0,
      mappingsWritten: 2,
      mappingsRetired: 0,
    });
    const before = await db.select().from(categories).orderBy(asc(categories.slug));
    expect(await seed(taxonomy)).toEqual({
      categoriesWritten: 0,
      categoriesDeactivated: 0,
      mappingsWritten: 0,
      mappingsRetired: 0,
    });
    expect(await db.select().from(categories).orderBy(asc(categories.slug))).toEqual(before);
    const hardware = before.find((c) => c.slug === 'hardware_store');
    expect(hardware).toMatchObject({
      path: 'shops.hardware_store',
      parentId: before.find((c) => c.slug === 'shops')?.id,
    });
    expect(hardware?.searchText).toContain('quincaillerie');
    const [meta] = await db.select().from(appMeta).where(eq(appMeta.key, TAXONOMY_VERSION_KEY));
    expect(meta?.value).toEqual({ version: 1 });
  });

  it('answers descendant queries on path and accent-insensitive trigram search', async () => {
    const descendants = await db
      .select({ slug: categories.slug })
      .from(categories)
      .where(sql`${categories.path} <@ 'shops'`)
      .orderBy(asc(categories.slug));
    expect(descendants.map((d) => d.slug)).toEqual(['florist', 'hardware_store', 'shops']);
    const [best] = await db
      .select({ slug: categories.slug })
      .from(categories)
      .orderBy(sql`word_similarity(f_unaccent(lower('Quincaillérie')), ${categories.searchText}) DESC`)
      .limit(1);
    expect(best?.slug).toBe('hardware_store');
  });

  it('never overwrites human mappings, retires dropped seed mappings and deactivates dropped categories', async () => {
    await db
      .update(categoryMappings)
      .set({ origin: 'human', confidence: 1 })
      .where(eq(categoryMappings.providerKey, 'florist'));
    const changed = taxonomyOf(
      TREE().replace(/ {6}- slug: florist\n {8}labels: \{ en: Florist, fr: Fleuriste \}\n/, ''),
      MAPPINGS('hardware_store_v2').replace('  - { key: florist, category: florist }\n', ''),
    );
    const result = await seed(changed);
    expect(result).toMatchObject({ categoriesDeactivated: 1, mappingsWritten: 1, mappingsRetired: 1 });
    const mappings = await db.select().from(categoryMappings).orderBy(asc(categoryMappings.providerKey));
    expect(mappings.map((m) => [m.providerKey, m.origin, m.status])).toEqual([
      ['florist', 'human', 'active'],
      ['hardware_store', 'seed', 'rejected'],
      ['hardware_store_v2', 'seed', 'active'],
    ]);
    const [florist] = await db.select().from(categories).where(eq(categories.slug, 'florist'));
    expect(florist?.isActive).toBe(false);
  });

  it('seeds the committed taxonomy files idempotently', async () => {
    const taxonomy = loadTaxonomy();
    await seed(taxonomy);
    const second = await seed(taxonomy);
    expect(second).toMatchObject({ categoriesWritten: 0, mappingsWritten: 0 });
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(categories)
      .where(eq(categories.isActive, true));
    expect(count?.n).toBe(taxonomy.categories.length);
  });
});
