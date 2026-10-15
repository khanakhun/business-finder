import type { ApiEnv } from '@bf/config';
import type { INestApplicationContext } from '@nestjs/common';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestWorker, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import {
  type Browser,
  createWorkspace,
  inviteAndJoin,
  PASSWORD,
  signUpVerified,
} from '../../../test/identity-helpers.ts';
import { baseUrlOf, openSse, sessionCookie } from '../../../test/sse-client.ts';

let t: TestApp;
let worker: INestApplicationContext;
const mailer = new FakeMailer();
// The worker sends notification emails; capture them separately from the API's system emails.
const workerMailer = new FakeMailer();
let owner: Browser;
let orgId: string;

const unread = async (client: Browser) =>
  (await client.get('/v1/notifications?unread=true').expect(200)).body as {
    items: Array<{ id: string; type: string; link: string | null }>;
    unreadCount: number;
  };

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 10 });
  await new Redis(t.env.VALKEY_URL).flushdb();
  worker = await createTestWorker(t, { mailer: workerMailer });
  owner = await signUpVerified(t, mailer, 'owner@notify.test', 'Olive Owner');
  orgId = await createWorkspace(owner, 'Notify Co');
});

afterAll(async () => {
  await worker?.close();
  await t?.close();
});

describe('notifications', () => {
  it('a test event becomes a notification and nudges the user’s open tabs', async () => {
    const baseUrl = await baseUrlOf(t.app);
    const cookie = await sessionCookie(
      baseUrl,
      (t.env as ApiEnv).APP_URL,
      'owner@notify.test',
      PASSWORD,
      '198.51.100.31',
    );
    const stream = await openSse(`${baseUrl}/v1/realtime`, { Cookie: cookie });
    await stream.ready();

    expect((await unread(owner)).unreadCount).toBe(0);
    const accepted = await owner.post('/v1/notifications/test').expect(202);
    expect(accepted.body.eventId).toEqual(expect.any(String));

    const [nudge] = await stream.waitFor('notification.created', 1, 10_000);
    // An anonymous nudge: the shared workspace stream never names the recipient.
    expect(JSON.parse(nudge?.data ?? '{}')).toMatchObject({ orgId, entity: 'notifications', payload: null });
    const page = await unread(owner);
    expect(page.unreadCount).toBe(1);
    expect(page.items[0]).toMatchObject({ type: 'system_test', link: '/notifications' });
    stream.close();
  });

  it('marks one or all read; another user cannot touch them', async () => {
    const [first] = (await unread(owner)).items;
    if (!first) throw new Error('expected a notification');
    const member = (await inviteAndJoin(t, mailer, owner, 'member@notify.test', 'member')).client;
    await member.post(`/v1/notifications/${first.id}/read`).expect(404);
    await owner.post(`/v1/notifications/${first.id}/read`).expect(204);
    await owner.post(`/v1/notifications/${first.id}/read`).expect(204);
    // (The member joining may have notified the owner meanwhile.)
    expect((await unread(owner)).items.map((n) => n.id)).not.toContain(first.id);

    await owner.post('/v1/notifications/test').expect(202);
    await owner.post('/v1/notifications/test').expect(202);
    await expect
      .poll(async () => (await unread(owner)).unreadCount, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(2);
    await owner.post('/v1/notifications/read-all').expect(204);
    expect((await unread(owner)).unreadCount).toBe(0);
    const all = await owner.get('/v1/notifications?limit=2').expect(200);
    expect(all.body.items).toHaveLength(2);
    expect(all.body.nextCursor).toEqual(expect.any(String));
  });

  it('tells existing members when someone joins, by email too when they opted in', async () => {
    const prefs = await owner.get('/v1/notifications/preferences').expect(200);
    expect(prefs.body.items).toContainEqual({ type: 'member_joined', inApp: true, email: false });
    await owner
      .put('/v1/notifications/preferences', { items: [{ type: 'member_joined', inApp: true, email: true }] })
      .expect(200);

    const joiner = (await inviteAndJoin(t, mailer, owner, 'joiner@notify.test', 'viewer')).client;
    await expect
      .poll(async () => (await unread(owner)).items.filter((n) => n.type === 'member_joined').length, {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(1);
    expect((await unread(joiner)).items.filter((n) => n.type === 'member_joined')).toEqual([]);
    await expect
      .poll(
        () =>
          workerMailer.sent.filter((m) => m.kind === 'notification' && m.to === 'owner@notify.test').length,
      )
      .toBeGreaterThanOrEqual(1);
    const email = workerMailer.sent.find((m) => m.kind === 'notification' && m.to === 'owner@notify.test');
    expect(email?.url).toBe('http://localhost:3000/settings/members');
  });

  it('respects in-app preferences', async () => {
    await owner
      .put('/v1/notifications/preferences', { items: [{ type: 'system_test', inApp: false, email: false }] })
      .expect(200);
    const before = (await owner.get('/v1/notifications?limit=200').expect(200)).body.items.length;
    const accepted = await owner.post('/v1/notifications/test').expect(202);
    // Wait for the delivery to be processed (the outbox row gets dispatched and the job completes).
    const { OutboxRepository } = await import('../platform/events/outbox.repository.ts');
    await expect
      .poll(
        async () => (await worker.get(OutboxRepository).find(accepted.body.eventId))?.dispatchedAt ?? null,
        {
          timeout: 10_000,
        },
      )
      .not.toBeNull();
    const { getQueueToken } = await import('@nestjs/bullmq');
    const { jobIdFor } = await import('@bf/queue');
    const queue = t.app.get(getQueueToken('events'));
    const jobId = jobIdFor('deliver', `${accepted.body.eventId}:realtime.notify-test`);
    await expect
      .poll(async () => (await queue.getJob(jobId))?.getState(), { timeout: 10_000 })
      .toBe('completed');
    expect((await owner.get('/v1/notifications?limit=200').expect(200)).body.items.length).toBe(before);
  });

  it('is for signed-in users only (API keys have no inbox)', async () => {
    const key = await owner.post('/v1/api-keys', { name: 'bot', permissions: ['business:read'] }).expect(201);
    await t.http
      .get('/v1/notifications')
      .set('Authorization', `Bearer ${key.body.key as string}`)
      .expect(403);
    await t.http.get('/v1/notifications').expect(401);
  });
});
