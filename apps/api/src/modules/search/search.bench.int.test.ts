import type { AiGateway } from '@bf/ai';
import { runInTransaction } from '@bf/db';
import { loadTaxonomy, seedTaxonomy } from '@bf/db/seed';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import { type Browser, createWorkspace, signUpVerified } from '../../../test/identity-helpers.ts';
import { seedSearchBench } from '../../cli/search-bench/seed.ts';
import { AI_GATEWAY } from '../platform/ai/ai.module.ts';
import { APP_ENV } from '../platform/config/app-env.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';

// Listing search benchmark (BF-022): `pnpm --filter @bf/api bench:search`. Skipped in normal runs. Seeds
// BF_BENCH_BUSINESSES (default 200k) synthetic businesses tracked by one workspace, BF_BENCH_EMBEDDED of them with
// vectors, then times representative requests end to end over HTTP (validation, SQL, serialization).
const RUN = process.env.BF_BENCH === '1';
const BUSINESSES = Number(process.env.BF_BENCH_BUSINESSES ?? 200_000);
const EMBEDDED = Number(process.env.BF_BENCH_EMBEDDED ?? 20_000);
const ROUNDS = Number(process.env.BF_BENCH_ROUNDS ?? 20);
const LIST_P95_MS = 300;
const WORDS = ['colibri', 'soleil', 'corail', 'lagon', 'baie', 'plage', 'coco', 'vanille'];
const FACETS_P95_MS = 500;

/** The query vector equals seeded row 5's, so the HNSW scan has a real neighbourhood to walk. */
const queryVector = Array.from({ length: 1536 }, (_, d) => Math.sin(5 * 0.37 + (d + 1) * 1.13 + 5));
const gateway = {
  embed: async (texts: readonly string[]) => ({
    vectors: texts.map(() => queryVector),
    model: 'bench',
    dims: 1536,
  }),
} as unknown as AiGateway;

const mailer = new FakeMailer();
let t: TestApp;
let owner: Browser;
let food: string;

beforeAll(async () => {
  if (!RUN) return;
  t = await createTestApp({ mailer, valkeyDb: 6, overrides: [{ token: AI_GATEWAY, value: gateway }] });
  const db = t.app.get(DB_CLIENT);
  await runInTransaction(db, (tx) => seedTaxonomy(tx, loadTaxonomy()));
  owner = await signUpVerified(t, mailer, 'owner@search-bench.test', 'Sid Search');
  const org = await createWorkspace(owner, 'Agence Banc Recherche');
  const ms = await seedSearchBench(db, {
    organizationId: org,
    businesses: BUSINESSES,
    embedded: EMBEDDED,
    embeddingModel: t.app.get(APP_ENV).AI_EMBEDDING_MODEL,
  });
  console.info(
    `search bench: seeded ${BUSINESSES} businesses (${EMBEDDED} embedded) in ${(ms / 1000).toFixed(1)} s`,
  );
  const [row] = (await db.execute(
    sql`SELECT id FROM categories WHERE slug = 'food_drink'`,
  )) as unknown as Array<{
    id: string;
  }>;
  food = row?.id as string;
}, 60 * 60_000);

afterAll(async () => {
  await t?.close();
});

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;

async function time(
  path: string | ((round: number) => string),
): Promise<{ p50: number; p95: number; rows: number }> {
  const at = (round: number) => (typeof path === 'string' ? path : path(round));
  let rows = 0;
  for (let i = 0; i < 3; i++) await owner.get(at(-1 - i)).expect(200);
  const samples: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const started = performance.now();
    const res = await owner.get(at(i)).expect(200);
    samples.push(performance.now() - started);
    rows = res.body.items?.length ?? res.body.total ?? 0;
  }
  samples.sort((a, b) => a - b);
  return { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), rows };
}

it.skipIf(!RUN)('serves listing p95 < 300 ms and facets p95 < 500 ms', { timeout: 60 * 60_000 }, async () => {
  // A cursor five pages deep in the score order.
  let deep = '/v1/businesses?sort=-score&limit=50';
  for (let i = 0; i < 5; i++) {
    const page = await owner.get(deep).expect(200);
    deep = `/v1/businesses?sort=-score&limit=50&cursor=${encodeURIComponent(page.body.nextCursor)}`;
  }
  const shapes: Array<[string, string | ((round: number) => string), number]> = [
    ['default (recent)', '/v1/businesses', LIST_P95_MS],
    ['category subtree, -score', `/v1/businesses?category=${food}&sort=-score`, LIST_P95_MS],
    [
      'radius + rating + email',
      '/v1/businesses?near=17.9,-62.85&radiusKm=2&rating[gte]=4&hasEmail=true',
      LIST_P95_MS,
    ],
    ['status + tag, -score', '/v1/businesses?status=qualified,contacted&tag=vip&sort=-score', LIST_P95_MS],
    ['5th page, -score', deep, LIST_P95_MS],
    ['text (FTS + trigram + vector)', '/v1/businesses?q=boulangerie%20colibri', LIST_P95_MS],
    ['text + status', '/v1/businesses?q=spa&status=new', LIST_P95_MS],
    // A new query each round: no cached ranking, a fresh embedding call, all three rankers.
    [
      'text, uncached',
      (round) => `/v1/businesses?q=boulangerie%20${WORDS[round & 7]}%20${round}`,
      LIST_P95_MS,
    ],
    ['facets + text, uncached', (round) => `/v1/businesses/facets?q=caf%C3%A9%20${round}`, FACETS_P95_MS],
    ['facets', '/v1/businesses/facets', FACETS_P95_MS],
    ['facets + category', `/v1/businesses/facets?category=${food}`, FACETS_P95_MS],
    ['facets + text', '/v1/businesses/facets?q=boulangerie', FACETS_P95_MS],
  ];
  const results: string[] = [];
  const slow: string[] = [];
  for (const [name, path, budget] of shapes) {
    const r = await time(path);
    results.push(`| ${name} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${budget} | ${r.rows} |`);
    if (r.p95 >= budget) slow.push(`${name}: p95 ${r.p95.toFixed(1)} ms ≥ ${budget} ms`);
  }
  console.info(
    [
      `search bench (${BUSINESSES} businesses, ${EMBEDDED} embedded, ${ROUNDS} rounds):`,
      '| query | p50 ms | p95 ms | budget ms | rows/total |',
      '|---|---|---|---|---|',
      ...results,
    ].join('\n'),
  );
  expect(slow).toEqual([]);
});
