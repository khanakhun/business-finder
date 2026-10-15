import { type BusinessFiltersInput, BusinessFiltersSchema } from '@bf/contracts';
import { type DbClient, runInTransaction } from '@bf/db';
import { loadTaxonomy, seedTaxonomy } from '@bf/db/seed';
import { type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import { createWorkspace, signUpVerified } from '../../../test/identity-helpers.ts';
import { seedSearchBench } from '../../cli/search-bench/seed.ts';
import { APP_ENV } from '../platform/config/app-env.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';
import { BUSINESS_SEARCH_REPOSITORY } from './application/listing-ports.ts';
import type { ListingSort, ListingSpec } from './domain/listing.ts';
import type { DrizzleBusinessSearchRepository } from './infrastructure/drizzle-business-search.repository.ts';

// The six most common listing query shapes can use their indexes (BF-022). The dataset is small, so sequential
// scans are disabled for the check: the test proves an index *applies* to the generated SQL (no function wrapped
// around an indexed column, matching operator class, sort order); the benchmark measures what the planner picks
// on 200k rows (pnpm --filter @bf/api bench:search).

const mailer = new FakeMailer();
let t: TestApp;
let db: DbClient;
let repository: DrizzleBusinessSearchRepository;
let org: string;

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 6 });
  db = t.app.get(DB_CLIENT);
  repository = t.app.get(BUSINESS_SEARCH_REPOSITORY);
  await runInTransaction(db, (tx) => seedTaxonomy(tx, loadTaxonomy()));
  const owner = await signUpVerified(t, mailer, 'owner@explain.test', 'Ezra Explain');
  org = await createWorkspace(owner, 'Plans');
  await seedSearchBench(db, {
    organizationId: org,
    businesses: 3_000,
    embedded: 300,
    embeddingModel: t.app.get(APP_ENV).AI_EMBEDDING_MODEL,
  });
});

afterAll(async () => {
  await t?.close();
});

const spec = (filters: BusinessFiltersInput = {}): ListingSpec => ({
  organizationId: org,
  filters: BusinessFiltersSchema.parse(filters),
  text: null,
  origin: null,
  addedSince: null,
});

/** Index names in the plan of `query` (and `<Sort>` for each sort node), planned without sequential scans. */
async function indexesUsed(query: SQLWrapper | SQL, settings: SQL[] = []): Promise<string[]> {
  return runInTransaction(db, async (tx) => {
    await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    for (const setting of settings) await tx.execute(setting);
    const [row] = (await tx.execute(sql`EXPLAIN (FORMAT JSON) ${query}`)) as unknown as Array<{
      'QUERY PLAN': unknown;
    }>;
    const names: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (key === 'Index Name' && typeof value === 'string') names.push(value);
          else if (key === 'Node Type' && value === 'Sort') names.push('<Sort>');
          else walk(value);
        }
      }
    };
    walk(row?.['QUERY PLAN']);
    return names;
  });
}

const sort = (key: ListingSort['key'], direction: ListingSort['direction'] = 'desc'): ListingSort => ({
  key,
  direction,
});

describe('listing query plans', () => {
  it('default listing (most recently tracked) walks the workspace index in order', async () => {
    const plan = await indexesUsed(repository.pageQuery(spec(), sort('recent'), null, 50));
    expect(plan).toContain('idx_org_businesses__organization_id_created_at');
    expect(plan).not.toContain('<Sort>'); // walks the index in order
  });

  it('score sort uses the score index', async () => {
    const plan = await indexesUsed(repository.pageQuery(spec(), sort('score'), null, 50));
    expect(plan).toContain('idx_org_businesses__organization_id_score');
    expect(plan).not.toContain('<Sort>'); // walks the index in order
  });

  it('full text uses the tsvector GIN index', async () => {
    expect(await indexesUsed(repository.fullTextQuery(spec(), 'boulangerie', 200))).toContain(
      'idx_businesses__search_tsv',
    );
  });

  it('name similarity uses the trigram GIN index', async () => {
    expect(await indexesUsed(repository.trigramQuery(spec(), 'colibri', 200))).toContain(
      'idx_businesses__normalized_name',
    );
  });

  it('radius filters use the location GiST index', async () => {
    expect(
      await indexesUsed(
        repository.pageQuery(spec({ near: '17.9,-62.85', radiusKm: '1' }), sort('recent'), null, 50),
      ),
    ).toContain('idx_businesses__location');
  });

  it('semantic ranking uses the HNSW index', async () => {
    const vector = Array.from({ length: 1536 }, (_, d) => Math.sin(5 * 0.37 + (d + 1) * 1.13 + 5));
    expect(
      await indexesUsed(repository.vectorQuery(spec(), vector, 200), repository.vectorSettings()),
    ).toContain('idx_businesses__embedding');
  });
});
