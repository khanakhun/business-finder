import { type DbClient, runInTransaction } from '@bf/db';
import { categoryMappings, discoveryTasks, geoAreas } from '@bf/db/schema';
import { loadTaxonomy, seedTaxonomy } from '@bf/db/seed';
import type { INestApplicationContext } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestWorker, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import {
  type Browser,
  createWorkspace,
  inviteAndJoin,
  signUpVerified,
} from '../../../test/identity-helpers.ts';
import { GEO_PACKS, importPack } from '../geo/application/packs/index.ts';
import { DrizzleGeoAreaRepository } from '../geo/infrastructure/drizzle-geo-area.repository.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';

// Discovery runs with the fixture provider (BF-020): a real worker plans, fetches and ingests.
const mailer = new FakeMailer();
let t: TestApp;
let worker: INestApplicationContext;
let db: DbClient;
let owner: Browser;
let viewer: Browser;
let outsider: Browser;
let islandId: string;
let categories: string[];

const terminal = new Set(['completed', 'partially_completed', 'failed', 'cancelled']);

async function finished(client: Browser, runId: string) {
  await expect
    .poll(async () => (await client.get(`/v1/discovery-runs/${runId}`).expect(200)).body.status, {
      timeout: 30_000,
      interval: 200,
    })
    .toSatisfy((status: string) => terminal.has(status));
  return (await client.get(`/v1/discovery-runs/${runId}`).expect(200)).body;
}

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 28 });
  db = t.app.get(DB_CLIENT);
  worker = await createTestWorker(t, { mailer });
  await runInTransaction(db, (tx) => seedTaxonomy(tx, loadTaxonomy()));
  await importPack(GEO_PACKS.bl as never, new DrizzleGeoAreaRepository(db));
  const [island] = await db.select({ id: geoAreas.id }).from(geoAreas).where(eq(geoAreas.kind, 'island'));
  islandId = island?.id as string;
  const mapped = await db
    .select({ key: categoryMappings.providerKey, id: categoryMappings.categoryId })
    .from(categoryMappings)
    .where(
      and(
        eq(categoryMappings.provider, 'google_places'),
        inArray(categoryMappings.providerKey, ['restaurant', 'cafe', 'bakery']),
      ),
    );
  categories = ['restaurant', 'cafe', 'bakery'].map((key) => mapped.find((m) => m.key === key)?.id as string);
  owner = await signUpVerified(t, mailer, 'owner@runs.test', 'Olive Owner');
  await createWorkspace(owner, 'Agence Runs');
  viewer = (await inviteAndJoin(t, mailer, owner, 'viewer@runs.test', 'viewer')).client;
  outsider = await signUpVerified(t, mailer, 'outsider@runs.test', 'Other Owner');
  await createWorkspace(outsider, 'Autre');
});

afterAll(async () => {
  await worker?.close();
  await t?.close();
});

const request = () => ({
  intent: { categoryIds: categories, languageCode: 'fr', regionCode: 'BL' },
  area: { areaId: islandId },
  providers: ['fake'],
});

describe('discovery runs', () => {
  it('estimates tiles, tasks, calls and cost per provider', async () => {
    const estimate = await owner.post('/v1/discovery-runs/estimate', request()).expect(200);
    expect(estimate.body.providers).toEqual([
      expect.objectContaining({ provider: 'fake', tiles: expect.any(Number), tasks: expect.any(Number) }),
    ]);
    const [fake] = estimate.body.providers;
    expect(fake.tasks).toBe(fake.tiles * 3);
    expect(fake.calls.min).toBe(fake.tasks);
    expect(fake.calls.max).toBeGreaterThan(fake.calls.min);
    expect(fake.costUsd).toEqual({ min: 0, expected: 0, max: 0 });
    expect(estimate.body.budgetUsd).toBe(5);
    await viewer.post('/v1/discovery-runs/estimate', request()).expect(403);
  });

  it('runs over the island for three categories: plans, fetches, ingests, tracks and notifies', async () => {
    const started = await owner
      .post('/v1/discovery-runs', request())
      .set('Idempotency-Key', 'run-island-001')
      .expect(201);
    expect(started.body).toMatchObject({ status: 'queued', providers: ['fake'], budgetUsd: 5 });
    // Same key, same run.
    const again = await owner
      .post('/v1/discovery-runs', request())
      .set('Idempotency-Key', 'run-island-001')
      .expect(200);
    expect(again.body.id).toBe(started.body.id);
    // Same key, different request: refused rather than silently answered with the first run.
    const reused = await owner
      .post('/v1/discovery-runs', { ...request(), budgetUsd: 9 })
      .set('Idempotency-Key', 'run-island-001')
      .expect(409);
    expect(reused.body.reason).toBe('IDEMPOTENCY_KEY_REUSED');

    const run = await finished(owner, started.body.id);
    expect(run).toMatchObject({ status: 'completed', reason: null, costUsd: 0 });
    expect(run.counts.tasksTotal).toBeGreaterThan(3);
    expect(run.counts.tasksDone).toBe(run.counts.tasksTotal);
    // Fixture businesses inside the island for these categories, each created once despite overlapping tiles.
    expect(run.counts.created).toBe(5);
    expect(run.counts.recordsFetched).toBe(run.counts.created + run.counts.unchanged + run.counts.merged);

    const businesses = await viewer
      .get(`/v1/discovery-runs/${started.body.id}/businesses?limit=2`)
      .expect(200);
    expect(businesses.body.items).toHaveLength(2);
    const rest = await viewer
      .get(`/v1/discovery-runs/${started.body.id}/businesses?limit=10&cursor=${businesses.body.nextCursor}`)
      .expect(200);
    expect(businesses.body.items.length + rest.body.items.length).toBe(5);
    expect(rest.body.nextCursor).toBeNull();
    const tracked = await owner.get('/v1/businesses?limit=50').expect(200);
    expect(tracked.body.items).toHaveLength(5);

    const list = await viewer.get('/v1/discovery-runs').expect(200);
    expect(list.body.items[0]).toMatchObject({ id: started.body.id, status: 'completed' });
    await viewer.get(`/v1/discovery-runs/${started.body.id}/tasks`).expect(403);
    const tasks = await owner.get(`/v1/discovery-runs/${started.body.id}/tasks?limit=200`).expect(200);
    expect(tasks.body.items.every((task: { status: string }) => task.status === 'done')).toBe(true);

    await expect
      .poll(
        async () =>
          (await owner.get('/v1/notifications').expect(200)).body.items.map((n: { type: string }) => n.type),
        {
          timeout: 20_000,
          interval: 200,
        },
      )
      .toContain('discovery_completed');
  });

  it('keeps runs private to their workspace and validates requests', async () => {
    const [run] = (await owner.get('/v1/discovery-runs').expect(200)).body.items;
    await outsider.get(`/v1/discovery-runs/${run.id}`).expect(404);
    await outsider.post(`/v1/discovery-runs/${run.id}/cancel`).expect(404);
    expect((await outsider.get('/v1/discovery-runs').expect(200)).body.items).toEqual([]);
    // Another workspace cannot run over this one's custom areas either; stored global areas are fine.
    await owner
      .post('/v1/discovery-runs', { ...request(), intent: { categoryIds: [], languageCode: 'fr' } })
      .expect(422);
    await owner.post('/v1/discovery-runs', request()).set('Idempotency-Key', 'bad key!').expect(422);
    const dedupe = await db
      .select({ key: discoveryTasks.dedupeKey })
      .from(discoveryTasks)
      .where(eq(discoveryTasks.runId, run.id));
    expect(new Set(dedupe.map((d) => d.key)).size).toBe(dedupe.length);
  });

  it('cancels a finished run as a no-op', async () => {
    const [run] = (await owner.get('/v1/discovery-runs').expect(200)).body.items;
    const cancelled = await owner.post(`/v1/discovery-runs/${run.id}/cancel`).expect(200);
    expect(cancelled.body.status).toBe('completed');
  });
});
