import { PIPELINE_STATUSES } from '@bf/contracts';
import type { DbClient } from '@bf/db';
import { activities, businesses, businessScores, orgBusinesses } from '@bf/db/schema';
import { aBusiness } from '@bf/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
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
import { CrmPipeline } from './index.ts';

// CRM basics (BF-024) end to end with real roles: owner, member (writes), viewer (reads), an outsider workspace,
// and a worker turning domain events into the activity timeline.

const mailer = new FakeMailer();
let t: TestApp;
let worker: INestApplicationContext;
let db: DbClient;
let owner: Browser;
let member: Browser;
let viewer: Browser;
let outsider: Browser;
let org: string;
let otherOrg: string;
let ownerId: string;
let memberId: string;
let outsiderId: string;

async function track(overrides: Parameters<typeof aBusiness>[0] = {}, org_ = org): Promise<string> {
  const business = aBusiness(overrides);
  await db.insert(businesses).values(business);
  await db
    .insert(orgBusinesses)
    .values({ organizationId: org_, businessId: business.id, addedVia: 'search' });
  return business.id;
}

async function timeline(client: Browser, id: string, count: number): Promise<{ type: string }[]> {
  await expect
    .poll(async () => (await client.get(`/v1/businesses/${id}/activities`).expect(200)).body.items.length, {
      timeout: 20_000,
      interval: 100,
    })
    .toBeGreaterThanOrEqual(count);
  return (await client.get(`/v1/businesses/${id}/activities`).expect(200)).body.items;
}

const userId = async (client: Browser) => (await client.get('/v1/me').expect(200)).body.user.id as string;

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 3 });
  db = t.app.get(DB_CLIENT);
  worker = await createTestWorker(t, { mailer });
  owner = await signUpVerified(t, mailer, 'owner@crm.test', 'Olga Owner');
  org = await createWorkspace(owner, 'Agence CRM');
  member = (await inviteAndJoin(t, mailer, owner, 'member@crm.test', 'member')).client;
  viewer = (await inviteAndJoin(t, mailer, owner, 'viewer@crm.test', 'viewer')).client;
  outsider = await signUpVerified(t, mailer, 'outsider@crm.test', 'Oscar Outsider');
  otherOrg = await createWorkspace(outsider, 'Ailleurs');
  [ownerId, memberId, outsiderId] = (await Promise.all([owner, member, outsider].map(userId))) as [
    string,
    string,
    string,
  ];
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await t?.close();
});

describe('pipeline status', () => {
  it('walks the state machine, lists the allowed moves and records reasons', async () => {
    const id = await track();
    const initial = await viewer.get(`/v1/businesses/${id}/crm`).expect(200);
    expect(initial.body).toMatchObject({
      businessId: id,
      pipelineStatus: 'new',
      statusChangedAt: null,
      allowedTransitions: [
        { to: 'qualified', requiresReason: false },
        { to: 'disqualified', requiresReason: true },
      ],
      tags: [],
      doNotContact: false,
      notesCount: 0,
      openTasksCount: 0,
    });
    const qualified = await member.post(`/v1/businesses/${id}/status`, { status: 'qualified' }).expect(200);
    expect(qualified.body).toMatchObject({
      pipelineStatus: 'qualified',
      statusChangedAt: '2026-10-14T12:00:00.000Z',
    });
    // Skipping steps is refused; automatic-only moves too.
    await member.post(`/v1/businesses/${id}/status`, { status: 'won' }).expect(409);
    await member.post(`/v1/businesses/${id}/status`, { status: 'engaged' }).expect(409); // site leads only
    // DECISION(BF-024): qualified → contacted → engaged may also be made by hand.
    await member.post(`/v1/businesses/${id}/status`, { status: 'contacted' }).expect(200);
    await member.post(`/v1/businesses/${id}/status`, { status: 'lost' }).expect(422);
    const lost = await member
      .post(`/v1/businesses/${id}/status`, { status: 'lost', reason: 'Went with a cousin' })
      .expect(200);
    expect(lost.body).toMatchObject({ pipelineStatus: 'lost', lostReason: 'Went with a cousin' });
    expect(lost.body.allowedTransitions).toEqual([{ to: 'qualified', requiresReason: false }]);
    // Same status: a no-op, not an error.
    await member.post(`/v1/businesses/${id}/status`, { status: 'lost', reason: 'again' }).expect(200);
  });

  it('lets the system mark contacted/engaged only where it applies', async () => {
    const id = await track();
    const pipeline = t.app.get(CrmPipeline);
    expect(await pipeline.markContacted(org, id)).toBe(false); // new → contacted is not a move
    await owner.post(`/v1/businesses/${id}/status`, { status: 'qualified' }).expect(200);
    expect(await pipeline.markContacted(org, id)).toBe(true);
    expect(await pipeline.markContacted(org, id)).toBe(false); // already there
    expect(await pipeline.markEngaged(org, id)).toBe(true);
    expect((await owner.get(`/v1/businesses/${id}/crm`).expect(200)).body.pipelineStatus).toBe('engaged');
    expect(await pipeline.markEngaged(otherOrg, id)).toBe(false); // not tracked there
  });

  it('applies bulk moves one by one and reports refusals', async () => {
    const a = await track();
    const b = await track();
    await owner.post(`/v1/businesses/${b}/status`, { status: 'qualified' }).expect(200);
    const foreign = await track({}, otherOrg);
    const result = await member
      .post('/v1/businesses/bulk/status', { businessIds: [a, b, foreign, a], status: 'qualified' })
      .expect(200);
    expect(result.body).toEqual({
      changed: 1,
      unchanged: 1,
      failed: [{ businessId: foreign, code: 'NOT_FOUND' }],
    });
    const lost = await member
      .post('/v1/businesses/bulk/status', { businessIds: [a, b], status: 'won' })
      .expect(200);
    expect(lost.body.failed.map((f: { code: string }) => f.code)).toEqual([
      'INVALID_STATE_TRANSITION',
      'INVALID_STATE_TRANSITION',
    ]);
    await viewer.post('/v1/businesses/bulk/status', { businessIds: [a], status: 'qualified' }).expect(403);
  });
});

describe('owner, tags and do-not-contact', () => {
  it('assigns members only and clears the owner', async () => {
    const id = await track();
    const assigned = await owner.put(`/v1/businesses/${id}/owner`, { ownerUserId: memberId }).expect(200);
    expect(assigned.body.ownerUserId).toBe(memberId);
    await owner.put(`/v1/businesses/${id}/owner`, { ownerUserId: outsiderId }).expect(422);
    const cleared = await owner.put(`/v1/businesses/${id}/owner`, { ownerUserId: null }).expect(200);
    expect(cleared.body.ownerUserId).toBeNull();
    await viewer.put(`/v1/businesses/${id}/owner`, { ownerUserId: ownerId }).expect(403);
  });

  it('adds and removes tags case-insensitively, capped at 30', async () => {
    const id = await track();
    const tagged = await member
      .post(`/v1/businesses/${id}/tags`, { add: ['VIP', 'vip', 'Restaurant'] })
      .expect(200);
    expect(tagged.body.tags).toEqual(['VIP', 'Restaurant']);
    const again = await member.post(`/v1/businesses/${id}/tags`, { add: ['restaurant'], remove: ['vip'] });
    expect(again.body.tags).toEqual(['Restaurant']);
    await member.post(`/v1/businesses/${id}/tags`, {}).expect(422);
    const many = Array.from({ length: 20 }, (_, i) => `tag-${i}`);
    await member.post(`/v1/businesses/${id}/tags`, { add: many }).expect(200);
    await member.post(`/v1/businesses/${id}/tags`, { add: many.map((tag) => `${tag}-b`) }).expect(422);
    const bulk = await member
      .post('/v1/businesses/bulk/tags', { businessIds: [id], remove: ['Restaurant'] })
      .expect(200);
    expect(bulk.body).toEqual({ changed: 1, unchanged: 0, failed: [] });
  });

  it('requires a reason to mark do-not-contact', async () => {
    const id = await track();
    await member.put(`/v1/businesses/${id}/do-not-contact`, { doNotContact: true }).expect(422);
    const marked = await member
      .put(`/v1/businesses/${id}/do-not-contact`, { doNotContact: true, reason: 'Asked us by phone' })
      .expect(200);
    expect(marked.body).toMatchObject({ doNotContact: true, doNotContactReason: 'Asked us by phone' });
    const unmarked = await member
      .put(`/v1/businesses/${id}/do-not-contact`, { doNotContact: false })
      .expect(200);
    expect(unmarked.body).toMatchObject({ doNotContact: false, doNotContactReason: null });
  });
});

describe('notes and tasks', () => {
  it('keeps notes to their author for edits and counts them', async () => {
    const id = await track();
    const note = await member
      .post(`/v1/businesses/${id}/notes`, { bodyMarkdown: '**Owner** prefers WhatsApp' })
      .expect(201);
    await owner.post(`/v1/businesses/${id}/notes`, { bodyMarkdown: 'Pinned', pinned: true }).expect(201);
    const list = (await viewer.get(`/v1/businesses/${id}/notes`).expect(200)).body.items;
    expect(list.map((n: { bodyMarkdown: string }) => n.bodyMarkdown)).toEqual([
      'Pinned',
      '**Owner** prefers WhatsApp',
    ]);
    await owner.patch(`/v1/notes/${note.body.id}`, { pinned: true }).expect(403);
    await outsider.patch(`/v1/notes/${note.body.id}`, { pinned: true }).expect(404);
    const edited = await member.patch(`/v1/notes/${note.body.id}`, { bodyMarkdown: 'Edited' }).expect(200);
    expect(edited.body.bodyMarkdown).toBe('Edited');
    expect((await owner.get(`/v1/businesses/${id}/crm`).expect(200)).body.notesCount).toBe(2);
    await owner.delete(`/v1/notes/${note.body.id}`).expect(403);
    await member.delete(`/v1/notes/${note.body.id}`).expect(204);
    await member.delete(`/v1/notes/${note.body.id}`).expect(404);
    expect((await owner.get(`/v1/businesses/${id}/crm`).expect(200)).body.notesCount).toBe(1);
    await viewer.post(`/v1/businesses/${id}/notes`, { bodyMarkdown: 'Nope' }).expect(403);
    await owner.post(`/v1/businesses/${id}/notes`, { bodyMarkdown: '   ' }).expect(422);
  });

  it('lists tasks by assignee and due window, and keeps counters current', async () => {
    const id = await track({ displayName: 'Boulangerie du Port' });
    // The test clock is 2026-10-14T12:00Z.
    const overdue = await owner
      .post(`/v1/businesses/${id}/tasks`, { title: 'Call back', type: 'call', dueAt: '2026-10-13T09:00:00Z' })
      .expect(201);
    expect(overdue.body).toMatchObject({
      businessName: 'Boulangerie du Port',
      assigneeId: ownerId,
      createdBy: ownerId,
      status: 'open',
    });
    await owner
      .post(`/v1/businesses/${id}/tasks`, { title: 'Visit', type: 'visit', dueAt: '2026-10-14T16:00:00Z' })
      .expect(201);
    await owner.post(`/v1/businesses/${id}/tasks`, { title: 'Someday' }).expect(201);
    await owner
      .post(`/v1/businesses/${id}/tasks`, {
        title: 'For member',
        assigneeId: memberId,
        dueAt: '2026-10-20T08:00:00Z',
      })
      .expect(201);
    await owner.post(`/v1/businesses/${id}/tasks`, { title: 'Outsider', assigneeId: outsiderId }).expect(422);

    const titles = async (client: Browser, query: string) =>
      (await client.get(`/v1/tasks?${query}`).expect(200)).body.items.map(
        (task: { title: string }) => task.title,
      );
    expect(await titles(owner, '')).toEqual(['Call back', 'Visit', 'Someday']);
    expect(await titles(owner, 'due=overdue')).toEqual(['Call back']);
    expect(await titles(owner, 'due=today')).toEqual(['Visit']);
    expect(await titles(owner, 'due=upcoming')).toEqual(['Someday']);
    // In Saint-Barthélemy (UTC-4) it is 08:00 on the 14th: 16:00Z is still today, and so is 02:00Z on the 15th.
    const late = await owner
      .post(`/v1/businesses/${id}/tasks`, { title: 'Late tonight', dueAt: '2026-10-15T02:00:00Z' })
      .expect(201);
    expect(await titles(owner, 'due=today&tz=America/St_Barthelemy')).toEqual(['Visit', 'Late tonight']);
    expect(await titles(owner, 'due=today')).toEqual(['Visit']);
    await owner.get('/v1/tasks?tz=Mars/Olympus').expect(422);
    await owner.patch(`/v1/tasks/${late.body.id}`, { status: 'cancelled' }).expect(200);
    expect(await titles(member, '')).toEqual(['For member']);
    expect(await titles(owner, `assignee=${memberId}`)).toEqual(['For member']);
    expect(await titles(outsider, '')).toEqual([]);
    const first = await owner.get('/v1/tasks?limit=2').expect(200);
    const next = await owner.get(`/v1/tasks?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(next.body.items.map((task: { title: string }) => task.title)).toEqual(['Someday']);
    await owner.get('/v1/tasks?cursor=nope').expect(422);
    const all = (await viewer.get(`/v1/businesses/${id}/tasks`).expect(200)).body.items;
    expect(all).toHaveLength(4);

    expect((await owner.get(`/v1/businesses/${id}/crm`).expect(200)).body).toMatchObject({
      openTasksCount: 4,
      nextTaskDueAt: '2026-10-13T09:00:00.000Z',
    });
    const done = await member.patch(`/v1/tasks/${overdue.body.id}`, { status: 'done' }).expect(200);
    expect(done.body).toMatchObject({ status: 'done', completedAt: '2026-10-14T12:00:00.000Z' });
    expect(await titles(owner, 'status=done')).toEqual(['Call back']);
    expect((await owner.get(`/v1/businesses/${id}/crm`).expect(200)).body).toMatchObject({
      openTasksCount: 3,
      nextTaskDueAt: '2026-10-14T16:00:00.000Z',
    });
    await outsider.patch(`/v1/tasks/${overdue.body.id}`, { status: 'open' }).expect(404);
    await viewer.patch(`/v1/tasks/${overdue.body.id}`, { status: 'open' }).expect(403);
    await owner.patch(`/v1/tasks/${overdue.body.id}`, {}).expect(422);
  });
});

describe('activity timeline', () => {
  it('turns CRM events into one activity each, newest first, for the workspace only', async () => {
    const id = await track();
    await owner.post(`/v1/businesses/${id}/status`, { status: 'qualified' }).expect(200);
    // Scoring computes the first score on the pipeline move; do-not-contact then moves its tier (one entry).
    await expect
      .poll(
        async () =>
          (
            await db
              .select({ id: businessScores.businessId })
              .from(businessScores)
              .where(eq(businessScores.businessId, id))
          ).length,
        { timeout: 20_000, interval: 200 },
      )
      .toBeGreaterThan(0);
    await owner.put(`/v1/businesses/${id}/owner`, { ownerUserId: memberId }).expect(200);
    await owner.post(`/v1/businesses/${id}/tags`, { add: ['VIP'] }).expect(200);
    await owner
      .put(`/v1/businesses/${id}/do-not-contact`, { doNotContact: true, reason: 'Asked' })
      .expect(200);
    await owner.post(`/v1/businesses/${id}/notes`, { bodyMarkdown: 'Hello' }).expect(201);
    const task = await owner.post(`/v1/businesses/${id}/tasks`, { title: 'Call' }).expect(201);
    await owner.patch(`/v1/tasks/${task.body.id}`, { status: 'done' }).expect(200);

    // Scoring adds a `score.updated` entry (do-not-contact moves the tier to X): CRM entries are checked here.
    await expect
      .poll(async () => (await timeline(viewer, id, 7)).length, { timeout: 20_000, interval: 200 })
      .toBe(8);
    const items = (await timeline(viewer, id, 7)).filter((a) => a.type !== 'score.updated');
    expect(new Set(items.map((a) => a.type))).toEqual(
      new Set([
        'status.changed',
        'owner.changed',
        'tags.changed',
        'do_not_contact.changed',
        'note.added',
        'task.created',
        'task.completed',
      ]),
    );
    const status = items.find((a) => a.type === 'status.changed');
    expect(status).toMatchObject({
      actor: { type: 'user', id: ownerId },
      data: { from: 'new', to: 'qualified', reason: null, automatic: false },
    });
    const page = await viewer.get(`/v1/businesses/${id}/activities?limit=3`).expect(200);
    expect(page.body.items).toHaveLength(3);
    const rest = await viewer.get(
      `/v1/businesses/${id}/activities?limit=10&cursor=${encodeURIComponent(page.body.nextCursor)}`,
    );
    const all = (await viewer.get(`/v1/businesses/${id}/activities?limit=50`).expect(200)).body.items as {
      type: string;
    }[];
    // Seven CRM entries, plus the tier move (do-not-contact → X).
    const scoreEntries = all.filter((a) => a.type === 'score.updated').length;
    expect(scoreEntries).toBe(1);
    expect(all).toHaveLength(7 + scoreEntries);
    expect(rest.body.items).toHaveLength(4 + scoreEntries);
    expect(rest.body.nextCursor).toBeNull();
    await outsider.get(`/v1/businesses/${id}/activities`).expect(404);
    const rows = await db
      .select({ organizationId: activities.organizationId })
      .from(activities)
      .where(eq(activities.businessId, id));
    expect(rows.every((row) => row.organizationId === org)).toBe(true);
  });
});

describe('pipeline board', () => {
  it('counts every status and filters by owner and tag', async () => {
    const id = await track({ displayName: 'Board Business' });
    await owner.post(`/v1/businesses/${id}/status`, { status: 'qualified' }).expect(200);
    await owner.put(`/v1/businesses/${id}/owner`, { ownerUserId: ownerId }).expect(200);
    await owner.post(`/v1/businesses/${id}/tags`, { add: ['board'] }).expect(200);
    const board = (await viewer.get('/v1/pipeline').expect(200)).body;
    expect(board.columns.map((c: { status: string }) => c.status)).toEqual([...PIPELINE_STATUSES]);
    const tracked = (await db.select().from(orgBusinesses).where(eq(orgBusinesses.organizationId, org)))
      .length;
    expect(board.columns.reduce((sum: number, c: { count: number }) => sum + c.count, 0)).toBe(tracked);

    const mine = (await owner.get('/v1/pipeline?owner=me&tag=board').expect(200)).body;
    const qualified = mine.columns.find((c: { status: string }) => c.status === 'qualified');
    expect(qualified).toMatchObject({ count: 1 });
    expect(qualified.cards[0]).toMatchObject({
      businessId: id,
      displayName: 'Board Business',
      ownerUserId: ownerId,
      allowedTransitions: expect.arrayContaining([{ to: 'contacted', requiresReason: false }]),
    });
    const others = (await member.get('/v1/pipeline?owner=me&tag=board').expect(200)).body;
    expect(others.columns.every((c: { count: number }) => c.count === 0)).toBe(true);
    const limited = (await owner.get('/v1/pipeline?limit=1').expect(200)).body;
    expect(limited.columns.every((c: { cards: unknown[] }) => c.cards.length <= 1)).toBe(true);
    const foreign = (await outsider.get('/v1/pipeline').expect(200)).body;
    const foreignCards = foreign.columns.flatMap((c: { cards: { businessId: string }[] }) => c.cards);
    expect(foreignCards.map((card: { businessId: string }) => card.businessId)).not.toContain(id);
  });
});

describe('merges', () => {
  it('moves notes, tasks and activities to the survivor', async () => {
    const survivor = await track({ displayName: 'Survivor' });
    const merged = await track({ displayName: 'Duplicate' });
    await owner.post(`/v1/businesses/${merged}/notes`, { bodyMarkdown: 'Moved note' }).expect(201);
    await owner.post(`/v1/businesses/${merged}/tasks`, { title: 'Moved task' }).expect(201);
    // The duplicate went further: lost (with a reason), do-not-contact, owned and tagged.
    await owner.post(`/v1/businesses/${merged}/tags`, { add: ['from-duplicate'] }).expect(200);
    await owner.post(`/v1/businesses/${survivor}/tags`, { add: ['kept'] }).expect(200);
    await owner.put(`/v1/businesses/${merged}/owner`, { ownerUserId: memberId }).expect(200);
    for (const status of ['qualified', 'contacted']) {
      await owner.post(`/v1/businesses/${merged}/status`, { status }).expect(200);
    }
    await owner
      .post(`/v1/businesses/${merged}/status`, { status: 'lost', reason: 'Chose a cousin' })
      .expect(200);
    await owner
      .put(`/v1/businesses/${merged}/do-not-contact`, { doNotContact: true, reason: 'Asked by phone' })
      .expect(200);
    await timeline(owner, merged, 2);
    await owner.post('/v1/businesses/merge', { survivorId: survivor, mergedIds: [merged] }).expect(200);

    const items = await timeline(owner, survivor, 3);
    expect(items.map((a) => a.type)).toEqual(expect.arrayContaining(['business.merged']));
    expect((await owner.get(`/v1/businesses/${survivor}/crm`).expect(200)).body).toMatchObject({
      pipelineStatus: 'lost',
      lostReason: 'Chose a cousin',
      ownerUserId: memberId,
      tags: ['from-duplicate', 'kept'],
      doNotContact: true,
      doNotContactReason: 'Asked by phone',
    });
    // Compliance hears that the survivor is now do-not-contact (BF-049 subscribes to this event).
    await expect
      .poll(async () => (await timeline(owner, survivor, 1)).map((a) => a.type))
      .toContain('do_not_contact.changed');
    const notes = (await owner.get(`/v1/businesses/${survivor}/notes`).expect(200)).body.items;
    expect(notes.map((n: { bodyMarkdown: string }) => n.bodyMarkdown)).toEqual(['Moved note']);
    await expect
      .poll(async () => (await owner.get(`/v1/businesses/${survivor}/crm`).expect(200)).body)
      .toMatchObject({ notesCount: 1, openTasksCount: 1 });
    const tasks = (await owner.get(`/v1/businesses/${survivor}/tasks`).expect(200)).body.items;
    expect(tasks.map((task: { businessId: string }) => task.businessId)).toEqual([survivor]);
  });
});

describe('authorization and validation', () => {
  it('scopes every route to the active workspace', async () => {
    const id = await track();
    for (const path of ['crm', 'notes', 'tasks', 'activities'])
      await outsider.get(`/v1/businesses/${id}/${path}`).expect(404);
    await outsider.post(`/v1/businesses/${id}/status`, { status: 'qualified' }).expect(404);
    await outsider.post(`/v1/businesses/${id}/notes`, { bodyMarkdown: 'x' }).expect(404);
    await owner.get('/v1/businesses/not-a-uuid/crm').expect(400);
    const row = await db
      .select({ status: orgBusinesses.pipelineStatus })
      .from(orgBusinesses)
      .where(and(eq(orgBusinesses.organizationId, org), eq(orgBusinesses.businessId, id)));
    expect(row[0]?.status).toBe('new');
  });

  it('lists teammates by name to every role, without emails', async () => {
    const teammates = (await viewer.get('/v1/teammates').expect(200)).body.items;
    expect(teammates).toHaveLength(3);
    expect(teammates.map((m: { userId: string }) => m.userId)).toEqual(
      expect.arrayContaining([ownerId, memberId]),
    );
    expect(Object.keys(teammates[0]).sort()).toEqual(['image', 'name', 'userId']);
    const theirs = (await outsider.get('/v1/teammates').expect(200)).body.items;
    expect(theirs.map((m: { userId: string }) => m.userId)).toEqual([outsiderId]);
  });

  it('refuses every change to a viewer', async () => {
    const id = await track();
    await viewer.post(`/v1/businesses/${id}/status`, { status: 'qualified' }).expect(403);
    await viewer.put(`/v1/businesses/${id}/owner`, { ownerUserId: null }).expect(403);
    await viewer.post(`/v1/businesses/${id}/tags`, { add: ['x'] }).expect(403);
    await viewer.put(`/v1/businesses/${id}/do-not-contact`, { doNotContact: false }).expect(403);
    await viewer.post(`/v1/businesses/${id}/notes`, { bodyMarkdown: 'x' }).expect(403);
    await viewer.post(`/v1/businesses/${id}/tasks`, { title: 'x' }).expect(403);
    await viewer.post('/v1/businesses/bulk/tags', { businessIds: [id], add: ['x'] }).expect(403);
  });

  it('keeps counters right under concurrent changes', async () => {
    const id = await track();
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        (i % 2 ? member : owner).post(`/v1/businesses/${id}/tasks`, { title: `Parallel ${i}` }).expect(201),
      ),
    );
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        owner.post(`/v1/businesses/${id}/notes`, { bodyMarkdown: `Parallel ${i}` }).expect(201),
      ),
    );
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((tag) => member.post(`/v1/businesses/${id}/tags`, { add: [tag] }).expect(200)),
    );
    const state = (await owner.get(`/v1/businesses/${id}/crm`).expect(200)).body;
    expect(state).toMatchObject({ openTasksCount: 6, notesCount: 4 });
    expect([...state.tags].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('requires a session', async () => {
    await t.http.get('/v1/pipeline').expect(401);
    await t.http.get('/v1/tasks').expect(401);
    await t.http.get('/v1/teammates').expect(401);
  });
});
