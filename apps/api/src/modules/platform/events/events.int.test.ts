import { type DomainEvent, defineEvent } from '@bf/contracts';
import type { DbClient } from '@bf/db';
import { runInTransaction } from '@bf/db';
import { auditLogs, outboxEvents } from '@bf/db/schema';
import { registry as metricsRegistry } from '@bf/observability';
import type { INestApplicationContext } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestApp, createTestWorker, type TestApp } from '../../../../test/create-test-app.ts';
import { FakeMailer } from '../../../../test/fake-mailer.ts';
import {
  type Browser,
  createWorkspace,
  inviteAndJoin,
  signUpVerified,
} from '../../../../test/identity-helpers.ts';
import { DB_CLIENT } from '../db/db.module.ts';
import { getEventContext } from './event-context.ts';
import { EventRecorder } from './event-recorder.ts';
import type { DomainEventHandler } from './on-domain-event.decorator.ts';
import { OutboxReconciler } from './outbox-reconciler.service.ts';
import { OutboxRelay } from './outbox-relay.service.ts';
import { SubscriberRegistry } from './subscriber-registry.ts';

const ThingHappened = defineEvent('test.thing_happened', 1, z.object({ n: z.number().int() }));
const ThingFollowed = defineEvent('test.thing_followed', 1, z.object({ n: z.number().int() }));

let t: TestApp;
let db: DbClient;
let workers: INestApplicationContext[] = [];
const mailer = new FakeMailer();
let owner: Browser;
let orgId: string;

/** Every handler call, as `<subscriber>:<eventId>`. */
const calls: string[] = [];
const followed: Array<DomainEvent<typeof ThingFollowed>> = [];
let flakyFailures = new Set<string>();

const handlers: Record<string, DomainEventHandler> = {
  'test.counter': async (event) => void calls.push(`test.counter:${event.id}`),
  'test.second': async (event) => void calls.push(`test.second:${event.id}`),
  // Fails the first delivery of each event, then succeeds.
  'test.flaky': async (event) => {
    if (!flakyFailures.has(event.id)) {
      flakyFailures.add(event.id);
      throw new Error('transient failure');
    }
    calls.push(`test.flaky:${event.id}`);
  },
};

const record = (n: number) =>
  t.app
    .get(EventRecorder)
    .record(ThingHappened, { payload: { n }, orgId, actor: { type: 'system', id: null } });

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 8 });
  await new Redis(t.env.VALKEY_URL).flushdb();
  db = t.app.get(DB_CLIENT);
  owner = await signUpVerified(t, mailer, 'owner@events.test', 'Olive Owner');
  orgId = await createWorkspace(owner, 'Events Co');
  // Two worker processes: two relays race for the same outbox, two consumers share the queue.
  workers = [await createTestWorker(t), await createTestWorker(t)];
  for (const worker of workers) {
    const registry = worker.get(SubscriberRegistry);
    registry.add(
      { id: 'test.counter', events: [ThingHappened] },
      handlers['test.counter'] as DomainEventHandler,
    );
    registry.add(
      { id: 'test.second', events: [ThingHappened] },
      handlers['test.second'] as DomainEventHandler,
    );
    registry.add({ id: 'test.chain', events: [ThingHappened] }, async (event) => {
      // Events recorded while handling one are caused by it.
      if ((event.payload as { n: number }).n === 1000) {
        await worker.get(EventRecorder).record(ThingFollowed, { payload: { n: 1001 }, orgId });
      }
    });
    registry.add({ id: 'test.followed', events: [ThingFollowed] }, async (event) => {
      followed.push(event as DomainEvent<typeof ThingFollowed>);
      expect(getEventContext()?.subscriberId).toBe('test.followed');
    });
  }
});

afterAll(async () => {
  for (const worker of workers) await worker.close();
  await t?.close();
});

describe('transactional outbox', () => {
  it('records nothing when the transaction rolls back, and the event when it commits', async () => {
    const recorder = t.app.get(EventRecorder);
    let rolledBack = '';
    await expect(
      runInTransaction(db, async () => {
        rolledBack = (await recorder.record(ThingHappened, { payload: { n: -1 }, orgId })).id;
        throw new Error('use case failed');
      }),
    ).rejects.toThrow('use case failed');
    expect(await db.select().from(outboxEvents).where(eq(outboxEvents.id, rolledBack))).toEqual([]);

    const committed = await runInTransaction(db, () =>
      recorder.record(ThingHappened, { payload: { n: -2 }, orgId }),
    );
    const [row] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, committed.id));
    expect(row).toMatchObject({ type: 'test.thing_happened', version: 1, organizationId: orgId });
  });

  it('delivers each event once per subscriber with two relays racing and duplicate wake-ups', async () => {
    const events = await Promise.all(Array.from({ length: 20 }, (_, i) => record(i)));
    for (const worker of workers) for (let i = 0; i < 5; i++) worker.get(OutboxRelay).wake();
    const allHandled = () =>
      events.every(
        (event) => calls.includes(`test.counter:${event.id}`) && calls.includes(`test.second:${event.id}`),
      );
    await expect.poll(allHandled, { timeout: 20_000, interval: 100 }).toBe(true);
    for (const event of events) {
      expect(calls.filter((c) => c === `test.counter:${event.id}`)).toHaveLength(1);
      expect(calls.filter((c) => c === `test.second:${event.id}`)).toHaveLength(1);
    }
    const pending = await db.select().from(outboxEvents).where(eq(outboxEvents.type, 'test.thing_happened'));
    expect(pending.every((row) => row.dispatchedAt !== null)).toBe(true);
    const dispatched = await metricsRegistry.getSingleMetric('bf_outbox_events_dispatched_total')?.get();
    expect(dispatched?.values.length).toBeGreaterThan(0);
  });

  it('retries a failing subscriber without affecting the others', async () => {
    for (const worker of workers) {
      worker
        .get(SubscriberRegistry)
        .add({ id: 'test.flaky', events: [ThingHappened] }, handlers['test.flaky'] as DomainEventHandler);
    }
    flakyFailures = new Set();
    const event = await record(500);
    await expect.poll(() => calls.includes(`test.counter:${event.id}`), { timeout: 10_000 }).toBe(true);
    expect(calls.includes(`test.flaky:${event.id}`)).toBe(false);
    // Retried after the queue's backoff (2 s).
    await expect
      .poll(() => calls.includes(`test.flaky:${event.id}`), { timeout: 15_000, interval: 200 })
      .toBe(true);
    expect(calls.filter((c) => c === `test.counter:${event.id}`)).toHaveLength(1);
  });

  it('propagates correlation and causation to events recorded by subscribers', async () => {
    const parent = await record(1000);
    await expect.poll(() => followed.length, { timeout: 10_000 }).toBe(1);
    expect(followed[0]).toMatchObject({
      causationId: parent.id,
      correlationId: parent.correlationId,
      actor: { type: 'system', id: 'test.chain' },
    });
  });

  it('the reconciler makes stuck events due again', async () => {
    const [worker] = workers;
    if (!worker) throw new Error('no worker');
    const stuck = await record(2000);
    // Simulate an event whose dispatch kept failing: far in backoff, recorded 10 minutes ago.
    await db
      .update(outboxEvents)
      .set({
        dispatchedAt: null,
        availableAt: new Date(Date.now() + 3_600_000),
        occurredAt: new Date(Date.now() - 600_000),
      })
      .where(eq(outboxEvents.id, stuck.id));
    calls.splice(0, calls.length);
    const result = await worker.get(OutboxReconciler).reconcile();
    expect(result.released).toBeGreaterThanOrEqual(1);
    await expect
      .poll(
        async () =>
          (await db.select().from(outboxEvents).where(eq(outboxEvents.id, stuck.id)))[0]?.dispatchedAt,
        { timeout: 10_000 },
      )
      .not.toBeNull();
  });
});

describe('identity events through the outbox', () => {
  it('land in the audit log once, with the request facts', async () => {
    await inviteAndJoin(t, mailer, owner, 'member@events.test', 'member');
    const invited = async () =>
      db.select().from(auditLogs).where(eq(auditLogs.action, 'identity.member_invited'));
    await expect.poll(async () => (await invited()).length, { timeout: 10_000 }).toBe(1);
    const [entry] = await invited();
    expect(entry).toMatchObject({ organizationId: orgId, actorType: 'user', entityType: 'invitation' });
    expect(entry?.ip).toMatch(/^203\.0\.113\./);
    const [event] = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.type, 'identity.member_invited'));
    // The audit entry takes the event's id: a redelivery inserts nothing.
    expect(entry?.id).toBe(event?.id);
  });

  it('owners can replay an event to a subscriber; others cannot', async () => {
    const [event] = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.type, 'identity.member_invited'));
    if (!event) throw new Error('no event');
    const body = { subscriberId: 'workspace.audit-identity' };
    const accepted = await owner.post(`/v1/events/${event.id}/replay`, body).expect(202);
    expect(accepted.body.jobId).toEqual(expect.any(String));
    await owner.post(`/v1/events/${event.id}/replay`, { subscriberId: 'test.counter' }).expect(404);
    await owner.post(`/v1/events/01990000-0000-7000-8000-000000000000/replay`, body).expect(404);

    const admin = (await inviteAndJoin(t, mailer, owner, 'admin@events.test', 'admin')).client;
    await admin.post(`/v1/events/${event.id}/replay`, body).expect(403);
    const outsider = await signUpVerified(t, mailer, 'outsider@events.test', 'Other');
    await createWorkspace(outsider, 'Elsewhere');
    await outsider.post(`/v1/events/${event.id}/replay`, body).expect(404);
    // Still a single audit entry for the invitation (idempotent receiver), plus the replay itself.
    await expect
      .poll(
        async () => (await db.select().from(auditLogs).where(eq(auditLogs.action, 'events.replayed'))).length,
      )
      .toBe(1);
    expect((await db.select().from(auditLogs).where(eq(auditLogs.id, event.id))).length).toBe(1);
  });
});
