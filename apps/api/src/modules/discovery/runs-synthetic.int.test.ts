import { type DbClient, runInTransaction } from '@bf/db';
import {
  businessSources,
  categoryMappings,
  discoveryTasks,
  geoAreas,
  orgBusinesses,
  providerUsage,
} from '@bf/db/schema';
import { loadTaxonomy, seedTaxonomy } from '@bf/db/seed';
import { QUEUES } from '@bf/queue';
import type { INestApplicationContext } from '@nestjs/common';
import { Queue } from 'bullmq';
import { and, eq, gt, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestWorker, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import { type Browser, createWorkspace, signUpVerified } from '../../../test/identity-helpers.ts';
import { GEO_PACKS, importPack } from '../geo/application/packs/index.ts';
import { DrizzleGeoAreaRepository } from '../geo/infrastructure/drizzle-geo-area.repository.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';
import { RunReconciler, STALE_AFTER_MS } from './infrastructure/run-reconciler.ts';

// Discovery runs with the synthetic fake provider ($1 per call, grid records that saturate dense tiles):
// adaptive tiling, budget stop, cancellation and crash recovery (BF-020).
const mailer = new FakeMailer();
const SYNTHETIC = { FAKE_DISCOVERY_SYNTHETIC: 'true' };
let t: TestApp;
let worker: INestApplicationContext | undefined;
let db: DbClient;
let owner: Browser;
let islandId: string;
let restaurant: string;
let cafe: string;
let bakery: string;
let manyCategories: string[];

const terminal = new Set(['completed', 'partially_completed', 'failed', 'cancelled']);
const getRun = async (id: string) => (await owner.get(`/v1/discovery-runs/${id}`).expect(200)).body;
async function finished(id: string, timeout = 60_000) {
  await expect
    .poll(async () => (await getRun(id)).status, { timeout, interval: 200 })
    .toSatisfy((s: string) => terminal.has(s));
  return getRun(id);
}

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 27, env: SYNTHETIC });
  db = t.app.get(DB_CLIENT);
  worker = await createTestWorker(t, { mailer, env: SYNTHETIC });
  await runInTransaction(db, (tx) => seedTaxonomy(tx, loadTaxonomy()));
  await importPack(GEO_PACKS.bl as never, new DrizzleGeoAreaRepository(db));
  const [island] = await db.select({ id: geoAreas.id }).from(geoAreas).where(eq(geoAreas.kind, 'island'));
  islandId = island?.id as string;
  const mapped = await db
    .select({ key: categoryMappings.providerKey, id: categoryMappings.categoryId })
    .from(categoryMappings)
    .where(eq(categoryMappings.provider, 'google_places'));
  const idOf = (key: string) => mapped.find((m) => m.key === key)?.id as string;
  [restaurant, cafe, bakery] = [idOf('restaurant'), idOf('cafe'), idOf('bakery')];
  manyCategories = [...new Set(mapped.map((m) => m.id))].slice(0, 8);
  owner = await signUpVerified(t, mailer, 'owner@synthetic.test', 'Olive Owner');
  await createWorkspace(owner, 'Agence Synthétique');
});

afterAll(async () => {
  await worker?.close();
  await t?.close();
});

const start = async (body: Record<string, unknown>) =>
  (
    await owner
      .post('/v1/discovery-runs', {
        providers: ['fake'],
        intent: { categoryIds: [restaurant], languageCode: 'fr' },
        ...body,
      })
      .expect(201)
  ).body;

describe('adaptive tiling', () => {
  it('splits saturated tiles into quadtree children and ingests each business once', async () => {
    const gustavia = { geometry: { type: 'Circle', center: { lat: 17.897, lng: -62.85 }, radiusM: 1_400 } };
    const run = await finished((await start({ area: gustavia, budgetUsd: 100 })).id);
    expect(run.status).toBe('completed');
    const tasks = await db.select().from(discoveryTasks).where(eq(discoveryTasks.runId, run.id));
    const saturated = tasks.filter((task) => task.saturated);
    expect(saturated.length).toBeGreaterThan(0);
    const children = tasks.filter((task) => task.depth > 0);
    expect(children.length).toBeGreaterThanOrEqual(saturated.filter((s) => s.depth < 3).length);
    expect(
      children.every((child) => tasks.some((parent) => parent.id === child.parentTaskId && parent.saturated)),
    ).toBe(true);
    // Every grid business once, even though parent and child tiles overlap.
    const sources = await db
      .select({ ref: businessSources.providerRef, n: sql<number>`count(*)::int` })
      .from(businessSources)
      .where(like(businessSources.providerRef, 'fake:syn:%'))
      .groupBy(businessSources.providerRef);
    expect(sources.every((s) => s.n === 1)).toBe(true);
    expect(run.counts.created).toBe(sources.length);
    expect(run.costUsd).toBe(run.counts.tasksDone);
  });
});

describe('budget', () => {
  it('stops calling providers at the budget and ends partially completed', async () => {
    const run = await finished((await start({ area: { areaId: islandId }, budgetUsd: 3 })).id);
    expect(run).toMatchObject({ status: 'partially_completed', reason: 'budget' });
    expect(run.costUsd).toBeLessThanOrEqual(3);
    expect(run.counts.tasksDone).toBe(3);
    expect(run.counts.tasksSkipped).toBe(run.counts.tasksTotal - 3);
    const [usage] = await db
      .select({ calls: sql<number>`coalesce(sum(${providerUsage.calls}), 0)::int` })
      .from(providerUsage)
      .where(eq(providerUsage.provider, 'fake'));
    expect(usage?.calls).toBeGreaterThanOrEqual(3);
  });
});

describe('cancellation', () => {
  it('cancels a run: no provider call after the cancel, consistent final counts', async () => {
    const created = await start({
      area: { areaId: islandId },
      budgetUsd: 500,
      intent: { categoryIds: [restaurant, cafe, bakery], languageCode: 'fr' },
    });
    const cancelled = await owner.post(`/v1/discovery-runs/${created.id}/cancel`).expect(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect(cancelled.body.reason).toBe('cancelled');
    // In-flight work settles; nothing new starts.
    await expect
      .poll(
        async () =>
          (
            await db
              .select()
              .from(discoveryTasks)
              .where(and(eq(discoveryTasks.runId, created.id), eq(discoveryTasks.status, 'running')))
          ).length,
        { timeout: 20_000 },
      )
      .toBe(0);
    const run = await getRun(created.id);
    expect(run.status).toBe('cancelled');
    expect(run.counts.tasksDone + run.counts.tasksSkipped + run.counts.tasksFailed).toBe(
      run.counts.tasksTotal,
    );
    const calls = run.counts.tasksDone;
    const later = await getRun(created.id);
    expect(later.counts.tasksDone).toBe(calls);
  });
});

describe('limits', () => {
  it('refuses a fourth active run and oversized plans', async () => {
    const big = {
      area: { areaId: islandId },
      budgetUsd: 500,
      intent: { categoryIds: [restaurant, cafe, bakery], languageCode: 'fr' },
    };
    const runs = [await start(big), await start(big), await start(big)];
    const fourth = await owner
      .post('/v1/discovery-runs', {
        providers: ['fake'],
        intent: { categoryIds: [restaurant], languageCode: 'fr' },
        area: { areaId: islandId },
      })
      .expect(409);
    expect(fourth.body.reason).toBe('TOO_MANY_ACTIVE_RUNS');
    for (const run of runs) await owner.post(`/v1/discovery-runs/${run.id}/cancel`).expect(200);
    // ~20,000 km² of 1.5 km circles × 8 categories: beyond the task cap, refused before any query is built.
    const huge = { geometry: { type: 'Circle', center: { lat: 17.9, lng: -62.85 }, radiusM: 80_000 } };
    const refused = await owner
      .post('/v1/discovery-runs/estimate', {
        providers: ['fake'],
        intent: { categoryIds: manyCategories, languageCode: 'fr' },
        area: huge,
      })
      .expect(422);
    expect(refused.body.errors[0].message).toMatch(/at most 20000/);
  });
});

describe('crash recovery', () => {
  it('completes after the worker dies mid-run and its jobs are lost, without duplicate ingestion', async () => {
    const created = await start({
      area: { areaId: islandId },
      budgetUsd: 500,
      intent: { categoryIds: [cafe, bakery], languageCode: 'fr' },
    });
    await expect
      .poll(async () => (await getRun(created.id)).counts.tasksDone, { timeout: 30_000, interval: 50 })
      .toBeGreaterThan(0);
    // The worker dies…
    await worker?.close();
    worker = undefined;
    // …and the queues lose their jobs (Valkey wiped), leaving tasks queued/running in the database.
    for (const name of [QUEUES.discoveryPlan.name, QUEUES.discoveryFetch.name, QUEUES.discoveryIngest.name]) {
      const queue = new Queue(name, { connection: { url: t.env.VALKEY_URL } });
      await queue.obliterate({ force: true });
      await queue.close();
    }
    const before = await getRun(created.id);
    // A new worker starts later (past the staleness window); its reconciler rebuilds the queues from the database.
    const later = Date.now() + 2 * STALE_AFTER_MS;
    worker = await createTestWorker(t, { mailer, env: SYNTHETIC, clock: { now: () => new Date(later) } });
    await worker.get(RunReconciler).reconcile();
    const run = await finished(created.id);
    expect(['completed', 'partially_completed']).toContain(run.status);
    expect(run.counts.tasksTotal).toBeGreaterThanOrEqual(before.counts.tasksTotal);
    expect(run.counts.tasksDone + run.counts.tasksSkipped + run.counts.tasksFailed).toBe(
      run.counts.tasksTotal,
    );
    // No duplicates: one source per provider ref, one workspace link per business.
    const duplicates = await db
      .select({ ref: businessSources.providerRef })
      .from(businessSources)
      .groupBy(businessSources.providerRef)
      .having(gt(sql`count(*)`, 1));
    expect(duplicates).toEqual([]);
    const links = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(orgBusinesses)
      .where(and(eq(orgBusinesses.addedVia, 'discovery'), eq(orgBusinesses.addedRef, created.id)));
    expect(links[0]?.n).toBe(run.counts.created);
  });
});
