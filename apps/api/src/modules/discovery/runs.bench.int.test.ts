import { runInTransaction } from '@bf/db';
import { categoryMappings } from '@bf/db/schema';
import { loadTaxonomy, seedTaxonomy } from '@bf/db/seed';
import type { INestApplicationContext } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestApp, createTestWorker, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import { type Browser, createWorkspace, signUpVerified } from '../../../test/identity-helpers.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';

// Discovery throughput benchmark (BF-020): `pnpm --filter @bf/api bench:discovery`. Skipped in normal runs.
// The synthetic fake provider returns a grid point every 0.005° (~550 m) and saturates at 20 per call, so a
// square of BF_BENCH_DEGREES a side exercises the whole pipeline: tiling, quadtree splits, fetch, ingest, track.
const RUN = process.env.BF_BENCH === '1';
const DEGREES = Number(process.env.BF_BENCH_DEGREES ?? 0.2);
const TARGET_PER_HOUR = 1_000;

const mailer = new FakeMailer();
const SYNTHETIC = { FAKE_DISCOVERY_SYNTHETIC: 'true' };
let t: TestApp;
let worker: INestApplicationContext | undefined;
let owner: Browser;
let restaurant: string;

beforeAll(async () => {
  if (!RUN) return;
  t = await createTestApp({ mailer, valkeyDb: 14, env: SYNTHETIC });
  worker = await createTestWorker(t, { mailer, env: SYNTHETIC });
  const db = t.app.get(DB_CLIENT);
  await runInTransaction(db, (tx) => seedTaxonomy(tx, loadTaxonomy()));
  const [mapping] = await db
    .select({ id: categoryMappings.categoryId })
    .from(categoryMappings)
    .where(eq(categoryMappings.providerKey, 'restaurant'));
  restaurant = mapping?.id as string;
  owner = await signUpVerified(t, mailer, 'owner@bench.test', 'Bea Bench');
  await createWorkspace(owner, 'Agence Banc');
});

afterAll(async () => {
  await worker?.close();
  await t?.close();
});

it.skipIf(!RUN)(`discovers ≥ ${TARGET_PER_HOUR} businesses/hour`, { timeout: 30 * 60_000 }, async () => {
  const [west, south] = [-62.9, 17.85];
  const ring = [
    [west, south],
    [west + DEGREES, south],
    [west + DEGREES, south + DEGREES],
    [west, south + DEGREES],
    [west, south],
  ];
  const started = performance.now();
  const created = await owner
    .post('/v1/discovery-runs', {
      providers: ['fake'],
      intent: { categoryIds: [restaurant], languageCode: 'fr' },
      area: { geometry: { type: 'MultiPolygon', coordinates: [[ring]] } },
      budgetUsd: 10_000,
      options: { maxResults: 20_000 },
    })
    .expect(201);
  const terminal = ['completed', 'partially_completed', 'failed', 'cancelled'];
  let run = created.body;
  await expect
    .poll(
      async () => {
        run = (await owner.get(`/v1/discovery-runs/${created.body.id}`).expect(200)).body;
        return run.status;
      },
      { timeout: 30 * 60_000, interval: 500 },
    )
    .toSatisfy((status: string) => terminal.includes(status));
  const seconds = (performance.now() - started) / 1000;
  const perHour = Math.round((run.counts.created / seconds) * 3600);
  console.info(
    `discovery bench: ${run.counts.created} businesses, ${run.counts.tasksTotal} tasks, ` +
      `${run.counts.recordsFetched} records in ${seconds.toFixed(1)} s → ${perHour} businesses/hour`,
  );
  expect(run.status).toBe('completed');
  expect(run.counts.created).toBeGreaterThan(1_000);
  expect(perHour).toBeGreaterThanOrEqual(TARGET_PER_HOUR);
});
