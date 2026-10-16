import type { ApiEnv } from '@bf/config';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import { createWorkspace, PASSWORD, signUpVerified } from '../../../test/identity-helpers.ts';
import { baseUrlOf, openSse, type SseConnection, sessionCookie } from '../../../test/sse-client.ts';
import { RealtimePublisher } from './application/realtime-publisher.ts';
import { MAX_STREAMS_PER_HOLDER } from './infrastructure/connection-limiter.ts';

let t: TestApp;
const mailer = new FakeMailer();
let baseUrl: string;
let orgA: string;
let orgB: string;
let cookieA: string;
let cookieB: string;
const open: SseConnection[] = [];

const connect = async (cookie: string, extra: Record<string, string> = {}, query = '') => {
  const connection = await openSse(`${baseUrl}/v1/realtime${query}`, { Cookie: cookie, ...extra });
  open.push(connection);
  return connection;
};
const publish = (orgId: string, n: number) =>
  t.app
    .get(RealtimePublisher)
    .publish(orgId, { type: 'test.ping', entity: 'test', entityId: String(n), payload: { n } });
const ns = (messages: Array<{ data?: string }>) =>
  messages.map((m) => (JSON.parse(m.data ?? '{}') as { payload: { n: number } }).payload.n);

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 9 });
  await new Redis(t.env.VALKEY_URL).flushdb();
  const a = await signUpVerified(t, mailer, 'a@realtime.test', 'Ann');
  orgA = await createWorkspace(a, 'Org A');
  const b = await signUpVerified(t, mailer, 'b@realtime.test', 'Bob');
  orgB = await createWorkspace(b, 'Org B');
  baseUrl = await baseUrlOf(t.app);
  const origin = (t.env as ApiEnv).APP_URL;
  cookieA = await sessionCookie(baseUrl, origin, 'a@realtime.test', PASSWORD, '198.51.100.21');
  cookieB = await sessionCookie(baseUrl, origin, 'b@realtime.test', PASSWORD, '198.51.100.22');
});

afterAll(async () => {
  for (const connection of open) connection.close();
  await t?.close();
});

describe('GET /v1/realtime', () => {
  it('requires a signed-in member', async () => {
    const anonymous = await openSse(`${baseUrl}/v1/realtime`, {});
    expect(anonymous.status).toBe(401);
  });

  it('streams the workspace events, never another workspace’s', async () => {
    const a = await connect(cookieA);
    const b = await connect(cookieB);
    expect(a.status).toBe(200);
    await Promise.all([a.ready(), b.ready()]);
    await publish(orgA, 1);
    await publish(orgB, 2);
    expect(ns(await a.waitFor('test.ping'))).toEqual([1]);
    expect(ns(await b.waitFor('test.ping'))).toEqual([2]);
    // B's event reached B's stream, so it would have reached A's by now too if isolation were broken.
    expect(ns(a.messages.filter((m) => m.event === 'test.ping'))).toEqual([1]);
    a.close();
    b.close();
  });

  it('replays what was missed after Last-Event-ID (header or query), then continues live', async () => {
    const first = await connect(cookieA);
    await first.ready();
    await publish(orgA, 10);
    const [seen] = await first.waitFor('test.ping');
    first.close();
    for (const n of [11, 12, 13]) await publish(orgA, n);

    const resumed = await connect(cookieA, { 'Last-Event-ID': seen?.id ?? '' });
    expect(ns(await resumed.waitFor('test.ping', 3))).toEqual([11, 12, 13]);
    await publish(orgA, 14);
    expect(ns(await resumed.waitFor('test.ping', 4))).toEqual([11, 12, 13, 14]);
    resumed.close();

    const viaQuery = await connect(cookieA, {}, `?lastEventId=${encodeURIComponent(seen?.id ?? '')}`);
    expect(ns(await viaQuery.waitFor('test.ping', 4))).toEqual([11, 12, 13, 14]);
    viaQuery.close();
  });

  it('asks clients that fell out of the retention window to resync', async () => {
    const stale = await connect(cookieA, { 'Last-Event-ID': '1-0' });
    const [resync] = await stale.waitFor('resync');
    expect(JSON.parse(resync?.data ?? '{}')).toEqual({ reason: 'retention' });
    stale.close();
  });

  it('limits open streams per user', async () => {
    const streams = await Promise.all(Array.from({ length: MAX_STREAMS_PER_HOLDER }, () => connect(cookieB)));
    expect(streams.every((s) => s.status === 200)).toBe(true);
    const extra = await connect(cookieB);
    expect(extra.status).toBe(429);
    for (const s of streams) s.close();
    // Released once the server notices the clients went away.
    await expect
      .poll(async () => {
        const again = await connect(cookieB);
        again.close();
        return again.status;
      })
      .toBe(200);
  });
});
