import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@bf/contracts';
import { createIsolatedDatabase, type IsolatedDatabase } from '@bf/testing/db';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createDb, type DbClient } from './client.ts';
import { applyMigrations, NO_TRANSACTION_MARKER } from './migrate.ts';

let database: IsolatedDatabase;
let db: DbClient;

beforeAll(async () => {
  database = await createIsolatedDatabase();
  db = createDb({ url: database.url, max: 2, applicationName: 'bf-int-test' });
});

afterAll(async () => {
  await closeDb(db);
  await database.drop();
});

/** A throwaway migrations folder in Drizzle's layout (journal + one .sql file per entry). */
function migrationsFolder(files: ReadonlyArray<readonly [tag: string, sql: string]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'bf-migrations-'));
  mkdirSync(join(dir, 'meta'));
  // Later than every committed migration, so they count as pending on a migrated database.
  const base = Date.now() + 1_000_000;
  const entries = files.map(([tag, body], idx) => {
    writeFileSync(join(dir, `${tag}.sql`), body);
    return { idx, version: '7', when: base + idx, tag, breakpoints: true };
  });
  writeFileSync(
    join(dir, 'meta/_journal.json'),
    JSON.stringify({ version: '7', dialect: 'postgresql', entries }),
  );
  return dir;
}

describe('applyMigrations', () => {
  it('runs CREATE INDEX CONCURRENTLY outside a transaction and the rest in one per migration', async () => {
    const dir = migrationsFolder([
      ['9001_table', 'CREATE TABLE mig_probe (id int PRIMARY KEY, name text);'],
      [
        '9002_index',
        `${NO_TRANSACTION_MARKER}\nCREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mig_probe__name ON mig_probe (name);`,
      ],
      // Fails half-way: its first statement must roll back with it.
      ['9003_broken', 'CREATE TABLE mig_partial (id int);\n--> statement-breakpoint\nSELECT 1/0;'],
    ]);
    const client = postgres(database.url, { max: 1, onnotice: () => undefined });
    try {
      await expect(applyMigrations(client, dir)).rejects.toThrow(/division by zero/);
      const [state] = await client<Array<{ index: string | null; partial: string | null; applied: number }>>`
        SELECT to_regclass('idx_mig_probe__name')::text AS index, to_regclass('mig_partial')::text AS partial,
          (SELECT count(*)::int FROM drizzle.__drizzle_migrations WHERE created_at > ${Date.now()}) AS applied`;
      expect(state).toEqual({ index: 'idx_mig_probe__name', partial: null, applied: 2 });
    } finally {
      await client.end();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('businesses search text', () => {
  const category = async (slug: string, en: string, fr: string, synonyms: string[] = []) => {
    const id = newId();
    await db.execute(sql`
      INSERT INTO categories (id, slug, path, labels, synonyms)
      VALUES (${id}, ${slug}, ${slug}::ltree, ${JSON.stringify({ en, fr })}::jsonb,
        ${JSON.stringify({ en: synonyms, fr: [] })}::jsonb)`);
    return id;
  };
  const business = async (name: string, locality: string | null = null) => {
    const id = newId();
    await db.execute(sql`
      INSERT INTO businesses (id, display_name, normalized_name, locality)
      VALUES (${id}, ${name}, ${name.toLowerCase()}, ${locality})`);
    return id;
  };
  const textOf = async (id: string) => {
    const [row] = (await db.execute(
      sql`SELECT category_text FROM businesses WHERE id = ${id}`,
    )) as unknown as Array<{
      category_text: string;
    }>;
    return row?.category_text;
  };
  const matches = async (id: string, query: string) => {
    const [row] = (await db.execute(sql`
      SELECT search_tsv @@ (websearch_to_tsquery('simple', f_unaccent(${query}))
        || websearch_to_tsquery('french', f_unaccent(${query}))
        || websearch_to_tsquery('english', f_unaccent(${query}))) AS hit
      FROM businesses WHERE id = ${id}`)) as unknown as Array<{ hit: boolean }>;
    return row?.hit;
  };

  it('keeps category_text in step with the business categories and their labels', async () => {
    const salon = await category('hair_salon_t', 'Hair salon', 'Salon de coiffure', ['hairdresser']);
    const cafe = await category('cafe_t', 'Café', 'Café');
    const id = await business('Chez Lulu', 'Gustavia');
    expect(await textOf(id)).toBe('');
    await db.execute(sql`
      INSERT INTO business_categories (business_id, category_id, is_primary, confidence, source)
      VALUES (${id}, ${salon}, true, 1, 'manual'), (${id}, ${cafe}, false, 1, 'manual')`);
    expect(await textOf(id)).toBe('Hair salon Salon de coiffure hairdresser Café Café');
    await db.execute(sql`UPDATE categories SET labels = '{"en":"Hair studio","fr":"Salon de coiffure"}'::jsonb
      WHERE id = ${salon}`);
    expect(await textOf(id)).toBe('Hair studio Salon de coiffure hairdresser Café Café');
    await db.execute(
      sql`DELETE FROM business_categories WHERE business_id = ${id} AND category_id = ${salon}`,
    );
    expect(await textOf(id)).toBe('Café Café');
  });

  it('searches names, categories and places accent-insensitively, with French and English stems', async () => {
    const bakery = await category('bakery_t', 'Bakery', 'Boulangerie');
    const id = await business('Crêperie du Port', 'Saint-Barthélemy');
    await db.execute(sql`
      INSERT INTO business_categories (business_id, category_id, is_primary, confidence, source)
      VALUES (${id}, ${bakery}, true, 1, 'manual')`);
    expect(await matches(id, 'creperie')).toBe(true);
    expect(await matches(id, 'boulangeries')).toBe(true); // French stem
    expect(await matches(id, 'bakeries')).toBe(true); // English stem
    expect(await matches(id, 'saint barthelemy')).toBe(true);
    expect(await matches(id, 'pizzeria')).toBe(false);
  });
});
