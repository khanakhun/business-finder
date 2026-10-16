import type { DbClient } from '@bf/db';
import {
  businesses,
  generationAttempts,
  generationEvents,
  generationJobs,
  orgBusinesses,
} from '@bf/db/schema';
import { QUEUES } from '@bf/queue';
import { aBusiness } from '@bf/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplicationContext } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestWorker, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import {
  type Browser,
  createWorkspace,
  inviteAndJoin,
  signUpVerified,
} from '../../../test/identity-helpers.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';
import { InMemoryObjectStorage } from '../platform/storage/object-storage.ts';
import { GENERATION_ARTIFACTS } from './application/ports.ts';
import { GENERATION_REAPER_AUTOSTART } from './infrastructure/bullmq-generation-queues.ts';

// Generation (BF-039) end to end with the fake engine: batches through the worker to published previews, a review,
// a repair, failover, cancellation, the batch's sequential mode, the sandbox pool, the reaper, idempotency and authz.

const ENV = {
  SITES_BASE_DOMAIN: 'sites.test',
  SITES_ASSETS_BASE_URL: 'https://assets.bf-sites.test',
  GENERATION_FAKE_ENGINE: 'true',
  GENERATION_FAKE_DURATION_MS: '200',
  GENERATION_MAX_SANDBOXES: '3',
  FAKE_SITE_INTEL: 'true',
};

const store = new InMemoryObjectStorage();
const artifacts = {
  put: (key: string, body: Buffer, type: string) => store.put(key, body, type),
  get: async (key: string) => (await store.get(key))?.body,
};
const overrides = [{ token: GENERATION_ARTIFACTS, value: artifacts }];

const mailer = new FakeMailer();
let t: TestApp;
let worker: INestApplicationContext;
let db: DbClient;
let member: Browser;
let viewer: Browser;
let outsider: Browser;
let org: string;

async function business(name: string): Promise<string> {
  const row = aBusiness({ displayName: name, locality: 'Gustavia' });
  await db.insert(businesses).values(row);
  await db.insert(orgBusinesses).values({ organizationId: org, businessId: row.id, addedVia: 'search' });
  return row.id;
}

async function eventually<T>(check: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const settled = (status: string) => ['succeeded', 'needs_review', 'failed', 'cancelled'].includes(status);

/** Polls the database (the API's rate limit is for people), then reads the batch through the API once. */
async function batchDone(id: string, timeoutMs = 45_000) {
  await eventually(async () => {
    const rows = await db
      .select({ status: generationJobs.status })
      .from(generationJobs)
      .where(eq(generationJobs.batchId, id));
    return rows.length > 0 && rows.every((row) => settled(row.status)) ? true : undefined;
  }, timeoutMs);
  return (await member.get(`/v1/generation-batches/${id}`).expect(200)).body;
}

async function jobStatus(id: string) {
  const [row] = await db
    .select({ status: generationJobs.status, attemptCount: generationJobs.attemptCount })
    .from(generationJobs)
    .where(eq(generationJobs.id, id));
  return row;
}

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 22, env: ENV, overrides });
  db = t.app.get(DB_CLIENT);
  worker = await createTestWorker(t, {
    mailer,
    env: ENV,
    overrides: [...overrides, { token: GENERATION_REAPER_AUTOSTART, value: false }],
  });
  for (const queue of [
    QUEUES.generationFake.name,
    QUEUES.generationQuality.name,
    QUEUES.generationReaper.name,
  ])
    await worker.get<Queue>(getQueueToken(queue)).obliterate({ force: true });
  member = await signUpVerified(t, mailer, 'member@gen.test', 'Gina Generator');
  org = await createWorkspace(member, 'Agence Gen');
  viewer = (await inviteAndJoin(t, mailer, member, 'viewer@gen.test', 'viewer')).client;
  outsider = await signUpVerified(t, mailer, 'outsider@gen.test', 'Otto Outsider');
  await createWorkspace(outsider, 'Ailleurs');
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await t?.close();
});

describe('generation batches', () => {
  it('generates sites through the worker to published previews, with an ordered event log', async () => {
    const ids = [await business('Café Saint-Jean'), await business('Salon Lumière')];
    const { body: created } = await member
      .post('/v1/generation-batches', { items: ids.map((businessId) => ({ businessId })) })
      .set('Idempotency-Key', 'batch-happy-1')
      .expect(201);
    expect(created.jobs).toHaveLength(2);
    expect(created.jobs[0]).toMatchObject({ engineCurrent: 'fake', engineRequested: 'auto', priority: 1 });
    expect(created.jobs[0].engineSelectionReason).toBeTruthy();

    // The same key returns the same batch; another body with it is refused.
    const { body: again } = await member
      .post('/v1/generation-batches', { items: ids.map((businessId) => ({ businessId })) })
      .set('Idempotency-Key', 'batch-happy-1')
      .expect(200);
    expect(again.id).toBe(created.id);
    await member
      .post('/v1/generation-batches', { items: [{ businessId: ids[0] }] })
      .set('Idempotency-Key', 'batch-happy-1')
      .expect(409);

    const done = await batchDone(created.id);
    expect(done.status).toBe('completed');
    for (const job of done.jobs) {
      expect(job).toMatchObject({ status: 'succeeded', attemptCount: 1 });
      expect(job.publishedUrl).toMatch(/^https?:\/\/.+sites\.test/);
      expect(job.resultVersionId).toBeTruthy();
      expect(job.costUsd).toBeGreaterThan(0);
    }
    const events = await db
      .select({ seq: generationEvents.seq, type: generationEvents.type })
      .from(generationEvents)
      .where(eq(generationEvents.jobId, done.jobs[0].id))
      .orderBy(asc(generationEvents.seq));
    // Gapless from 1, and the run's story in order.
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    const types = events.map((event) => event.type);
    expect(types.indexOf('status')).toBeLessThan(types.indexOf('done'));
    expect(types).toContain('usage');
    const { body: job } = await member.get(`/v1/generation-jobs/${done.jobs[0].id}`).expect(200);
    expect(job.attempts).toHaveLength(1);
    expect(job.attempts[0]).toMatchObject({ engine: 'fake', mode: 'create', status: 'succeeded' });
  }, 60_000);

  it('repairs an invalid result, and leaves a persistently failing one failed with its code', async () => {
    const invalid = await business('Atelier [invalid]');
    const failing = await business('Garage [fail:POLICY_VIOLATION]');
    const flaky = await business('Boutique [fail-once:TIMEOUT]');
    const { body } = await member
      .post('/v1/generation-batches', {
        items: [invalid, failing, flaky].map((businessId) => ({ businessId, engine: 'fake' })),
      })
      .expect(201);
    const done = await batchDone(body.id, 60_000);
    const byName = new Map((done.jobs as { businessName: string }[]).map((job) => [job.businessName, job]));
    expect(byName.get('Atelier [invalid]')).toMatchObject({ status: 'succeeded', attemptCount: 2 });
    const repaired = await db
      .select({ mode: generationAttempts.mode })
      .from(generationAttempts)
      .innerJoin(generationJobs, eq(generationJobs.id, generationAttempts.jobId))
      .where(eq(generationJobs.batchId, body.id));
    expect(repaired.map((attempt) => attempt.mode)).toContain('repair');
    expect(byName.get('Garage [fail:POLICY_VIOLATION]')).toMatchObject({
      status: 'failed',
      errorCode: 'POLICY_VIOLATION',
      attemptCount: 1,
    });
    expect(byName.get('Boutique [fail-once:TIMEOUT]')).toMatchObject({
      status: 'succeeded',
      attemptCount: 2,
    });
    expect(done.status).toBe('completed_with_issues');

    // A person retries the failed one (a new attempt).
    const failed = byName.get('Garage [fail:POLICY_VIOLATION]') as unknown as { id: string };
    const { body: retried } = await member.post(`/v1/generation-jobs/${failed.id}/retry`, {}).expect(200);
    expect(retried.status).toBe('queued');
  }, 90_000);

  it('runs a sequential batch one job at a time in priority order, and never more sandboxes than the pool', async () => {
    const ids = await Promise.all(['Un', 'Deux', 'Trois', 'Quatre'].map((name) => business(`Seq ${name}`)));
    const { body } = await member
      .post('/v1/generation-batches', {
        items: ids.map((businessId, index) => ({ businessId, engine: 'fake', priority: 4 - index })),
        settings: { maxParallel: 1 },
      })
      .expect(201);
    let maxRunning = 0;
    const done = await eventually(async () => {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(generationJobs)
        .where(
          sql`${generationJobs.batchId} = ${body.id} AND ${generationJobs.status} IN ('preparing', 'running', 'validating', 'repairing')`,
        );
      maxRunning = Math.max(maxRunning, row?.n ?? 0);
      const rows = await db
        .select({ status: generationJobs.status })
        .from(generationJobs)
        .where(eq(generationJobs.batchId, body.id));
      return rows.every((job) => settled(job.status)) ? true : undefined;
    }, 60_000).then(() =>
      member
        .get(`/v1/generation-batches/${body.id}`)
        .expect(200)
        .then((response) => response.body),
    );
    expect(maxRunning).toBeLessThanOrEqual(1);
    // Highest priority (1) first: started in reverse of the given order (attempts carry the database's time).
    const started = await db
      .select({ name: businesses.displayName })
      .from(generationAttempts)
      .innerJoin(generationJobs, eq(generationJobs.id, generationAttempts.jobId))
      .innerJoin(businesses, eq(businesses.id, generationJobs.businessId))
      .where(eq(generationJobs.batchId, body.id))
      .orderBy(asc(generationAttempts.startedAt));
    expect(started.map((row) => row.name)).toEqual(['Seq Quatre', 'Seq Trois', 'Seq Deux', 'Seq Un']);
    expect(done.status).toBe('completed');

    // Eight jobs in parallel batches: never more than the sandbox pool (3) at once.
    const many = await Promise.all(Array.from({ length: 8 }, (_, i) => business(`Pool ${i}`)));
    const { body: pool } = await member
      .post('/v1/generation-batches', { items: many.map((businessId) => ({ businessId, engine: 'fake' })) })
      .expect(201);
    let peak = 0;
    await eventually(async () => {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(generationAttempts)
        .where(eq(generationAttempts.status, 'running'));
      peak = Math.max(peak, row?.n ?? 0);
      const rows = await db
        .select({ status: generationJobs.status })
        .from(generationJobs)
        .where(eq(generationJobs.batchId, pool.id));
      return rows.every((job) => settled(job.status)) ? true : undefined;
    }, 60_000);
    expect(peak).toBeLessThanOrEqual(3);
  }, 150_000);

  it('cancels a waiting job at once and a running one within seconds', async () => {
    const slow = await business('Lent [slow]');
    const waiting = await business('Attente');
    const { body } = await member
      .post('/v1/generation-batches', {
        items: [slow, waiting].map((businessId) => ({ businessId, engine: 'fake' })),
        settings: { maxParallel: 1 },
      })
      .expect(201);
    const [first, second] = body.jobs as { id: string }[];
    const { body: cancelledWaiting } = await member
      .post(`/v1/generation-jobs/${second?.id}/cancel`, {})
      .expect(200);
    expect(cancelledWaiting.status).toBe('cancelled');
    await eventually(async () =>
      (await jobStatus(first?.id as string))?.status === 'running' ? true : undefined,
    );
    const asked = Date.now();
    await member.post(`/v1/generation-jobs/${first?.id}/cancel`, {}).expect(200);
    await eventually(
      async () => ((await jobStatus(first?.id as string))?.status === 'cancelled' ? true : undefined),
      15_000,
    );
    const stopped = (await member.get(`/v1/generation-jobs/${first?.id}`).expect(200)).body;
    expect(Date.now() - asked).toBeLessThan(10_000);
    expect(stopped.attempts[0].status).toBe('cancelled');
  }, 60_000);

  it('fails over an attempt whose worker died (the reaper) and finishes the job', async () => {
    const id = await business('Reaped');
    const { body } = await member
      .post('/v1/generation-batches', { items: [{ businessId: id, engine: 'fake' }] })
      .expect(201);
    const jobId = (body.jobs as { id: string }[])[0]?.id as string;
    await batchDone(body.id);
    // A dead attempt: running with an old heartbeat (as a killed worker leaves it), the job back in `running`.
    await db
      .update(generationJobs)
      .set({ status: 'running', attemptCount: 2, engineAttempts: 1 })
      .where(eq(generationJobs.id, jobId));
    await db.insert(generationAttempts).values({
      jobId,
      attemptNo: 2,
      engine: 'fake',
      mode: 'create',
      // Older than the reaper's two minutes by the app's (fixed) clock.
      heartbeatAt: new Date('2026-10-14T11:00:00.000Z'),
    });
    await worker.get<Queue>(getQueueToken(QUEUES.generationReaper.name)).add('reap', {
      orgId: null,
      idempotencyKey: `reap:test:${Date.now()}`,
    });
    await eventually(async () => {
      const row = await jobStatus(jobId);
      return row?.status === 'succeeded' && row.attemptCount === 3 ? true : undefined;
    }, 45_000);
    const recovered = (await member.get(`/v1/generation-jobs/${jobId}`).expect(200)).body;
    expect(recovered.attempts.map((attempt: { exitReason: string | null }) => attempt.exitReason)).toContain(
      'HEARTBEAT_LOST',
    );
  }, 60_000);

  it('streams a job’s events live then ends, and replays after Last-Event-ID without gaps or duplicates', async () => {
    const id = await business('Flux [slow]');
    const { body } = await member
      .post('/v1/generation-batches', { items: [{ businessId: id, engine: 'fake' }] })
      .expect(201);
    const jobId = (body.jobs as { id: string }[])[0]?.id as string;
    // Connected while it runs: the response ends when the job settles.
    const live = await member
      .get(`/v1/generation-jobs/${jobId}/events`)
      .buffer(true)
      .parse((res, done) => {
        let text = '';
        res.on('data', (chunk: Buffer) => {
          text += chunk.toString();
        });
        res.on('end', () => done(null, text));
      });
    const text = live.body as string;
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    expect(ids.length).toBeGreaterThan(5);
    expect(ids).toEqual(ids.map((_, index) => index + 1));
    expect(text).toContain('event: done');
    expect(text).toMatch(/event: job\ndata: \{"status":"succeeded"\}/);

    // Reconnecting after the fourth event: only the rest, then the end.
    const replay = await member
      .get(`/v1/generation-jobs/${jobId}/events`)
      .set('Last-Event-ID', '4')
      .buffer(true)
      .parse((res, done) => {
        let chunks = '';
        res.on('data', (chunk: Buffer) => {
          chunks += chunk.toString();
        });
        res.on('end', () => done(null, chunks));
      });
    const rest = [...(replay.body as string).matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    expect(rest).toEqual(ids.slice(4));
    await outsider.get(`/v1/generation-jobs/${jobId}/events`).expect(404);
  }, 60_000);

  it('regenerates an existing site as a new version, and notifies the batch’s creator', async () => {
    const id = await business('Régénéré');
    const first = await member
      .post('/v1/generation-batches', { items: [{ businessId: id, engine: 'fake' }] })
      .expect(201);
    const done = await batchDone(first.body.id);
    const siteId = done.jobs[0].siteId as string;
    const { body: again } = await member
      .post(`/v1/sites/${siteId}/regenerate`, { engine: 'fake' })
      .expect(201);
    expect(again.jobs[0]).toMatchObject({ siteId });
    const second = await batchDone(again.id);
    expect(second.jobs[0]).toMatchObject({ status: 'succeeded', siteId });
    expect(second.jobs[0].resultVersionId).not.toBe(done.jobs[0].resultVersionId);
    const notified = await eventually(async () => {
      const { body: page } = await member.get('/v1/notifications').expect(200);
      const items = (page.items ?? []) as { type: string; entityId: string | null }[];
      return items.find((item) => item.type === 'batch_completed' && item.entityId === again.id);
    });
    expect(notified).toBeTruthy();
  }, 90_000);

  it('hides batches from other workspaces and keeps viewers from generating', async () => {
    const id = await business('Privé');
    const { body } = await member
      .post('/v1/generation-batches', { items: [{ businessId: id, engine: 'fake' }] })
      .expect(201);
    await outsider.get(`/v1/generation-batches/${body.id}`).expect(404);
    await outsider.post(`/v1/generation-jobs/${body.jobs[0].id}/cancel`, {}).expect(404);
    await viewer.get(`/v1/generation-batches/${body.id}`).expect(200);
    await viewer.post('/v1/generation-batches', { items: [{ businessId: id }] }).expect(403);
    // A business another workspace tracks is not this one's to generate.
    await outsider.post('/v1/generation-batches', { items: [{ businessId: id }] }).expect(422);
    const { body: engines } = await member.get('/v1/generation/engines').expect(200);
    expect(engines.items.map((engine: { id: string }) => engine.id)).toEqual(['fake']);
    const { body: list } = await member.get('/v1/generation-batches?limit=2').expect(200);
    expect(list.items).toHaveLength(2);
    expect(list.nextCursor).toBeTruthy();
  }, 60_000);
});
