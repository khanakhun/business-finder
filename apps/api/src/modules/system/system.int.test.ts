import { registry } from '@bf/observability';
import { QUEUES } from '@bf/queue';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplicationContext } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestWorker, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import { type Browser, createWorkspace, signUpVerified } from '../../../test/identity-helpers.ts';

let t: TestApp;
let owner: Browser;
const mailer = new FakeMailer();
let worker: INestApplicationContext;
let queue: Queue;

const pings = async () =>
  (await registry.getSingleMetric('bf_system_pings_total')?.get())?.values[0]?.value ?? 0;
const completed = (jobId: string) =>
  expect
    .poll(async () => (await queue.getJob(jobId))?.getState(), { timeout: 10_000, interval: 50 })
    .toBe('completed');

beforeAll(async () => {
  t = await createTestApp({ valkeyDb: 4, mailer, env: { PLATFORM_OPERATOR_EMAILS: 'ops@example.test' } });
  await new Redis(t.env.VALKEY_URL).flushdb();
  // ping-jobs and Bull Board are operator tools (PLATFORM_OPERATOR_EMAILS).
  owner = await signUpVerified(t, mailer, 'ops@example.test', 'Ops');
  await createWorkspace(owner, 'Ops');
  worker = await createTestWorker(t);
  queue = t.app.get<Queue>(getQueueToken(QUEUES.system.name));
});

afterAll(async () => {
  await worker.close();
  await t.close();
});

describe('POST /v1/system/ping-jobs', () => {
  it('enqueues jobs that the worker processes', async () => {
    const before = await pings();
    const res = await owner.post('/v1/system/ping-jobs', { count: 2 }).expect(202);
    expect(res.body.jobIds).toHaveLength(2);
    for (const jobId of res.body.jobIds) await completed(jobId);
    const job = await queue.getJob(res.body.jobIds[1]);
    expect(job?.returnvalue).toEqual({ status: 'processed', result: { pong: 1 } });
    // Trace propagation needs the telemetry preload (absent in tests); covered by @bf/queue's integration test.
    expect(await pings()).toBe(before + 2);
  });

  it('defaults to one job', async () => {
    const res = await owner.post('/v1/system/ping-jobs', {}).expect(202);
    expect(res.body.jobIds).toHaveLength(1);
  });

  it('is idempotent per key: the same request twice is processed once', async () => {
    const first = await owner.post('/v1/system/ping-jobs', { idempotencyKey: 'demo-key' }).expect(202);
    await completed(first.body.jobIds[0]);
    const afterFirst = await pings();
    const second = await owner.post('/v1/system/ping-jobs', { idempotencyKey: 'demo-key' }).expect(202);
    expect(second.body.jobIds).toEqual(first.body.jobIds);
    expect(await pings()).toBe(afterFirst);
  });

  it.each([
    [{ count: 0 }, ['count']],
    [{ count: 11 }, ['count']],
    [{ count: 'two' }, ['count']],
    [{ idempotencyKey: '' }, ['idempotencyKey']],
  ])('rejects %j with 422 problem+json', async (body, path) => {
    const res = await owner.post('/v1/system/ping-jobs', body).expect(422);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path }] });
  });
});

describe('Bull Board', () => {
  it('is served to signed-in platform operators', async () => {
    await t.http.get('/admin/queues').expect(401);
    await owner.get('/admin/queues').expect(200);
    const api = await owner.get('/admin/queues/api/queues').expect(200);
    expect(api.body.queues.map((q: { name: string }) => q.name)).toContain('system');
    await t.http.get('/admin/queues/api/queues').expect(401);
  });
});

describe('POST /v1/system/ping-jobs without operator rights', () => {
  it('refuses anonymous callers and workspace owners who are not operators', async () => {
    await t.http.post('/v1/system/ping-jobs').send({}).expect(401);
    const owner = await signUpVerified(t, mailer, 'tenant-owner@example.test');
    await createWorkspace(owner, 'Tenant');
    await owner.post('/v1/system/ping-jobs', {}).expect(403);
    await owner.get('/admin/queues').expect(403);
  });
});
