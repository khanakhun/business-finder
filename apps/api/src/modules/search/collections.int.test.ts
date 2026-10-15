import type { DbClient } from '@bf/db';
import { auditLogs, businesses, orgBusinesses } from '@bf/db/schema';
import { aBusiness } from '@bf/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import {
  type Browser,
  createWorkspace,
  inviteAndJoin,
  signUpVerified,
} from '../../../test/identity-helpers.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';

// Saved searches, lists and the CSV export (BF-022) with real roles: owner, member (may change), viewer (reads).

const mailer = new FakeMailer();
let t: TestApp;
let db: DbClient;
let owner: Browser;
let member: Browser;
let viewer: Browser;
let outsider: Browser;
let org: string;
const ids: Record<string, string> = {};

async function track(
  key: string,
  overrides: Parameters<typeof aBusiness>[0],
  org_: Partial<typeof orgBusinesses.$inferInsert>,
) {
  const business = aBusiness(overrides);
  ids[key] = business.id;
  await db.insert(businesses).values(business);
  await db
    .insert(orgBusinesses)
    .values({ organizationId: org, businessId: business.id, addedVia: 'search', ...org_ });
}

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 6 });
  db = t.app.get(DB_CLIENT);
  owner = await signUpVerified(t, mailer, 'owner@lists.test', 'Olga Owner');
  org = await createWorkspace(owner, 'Agence Listes');
  member = (await inviteAndJoin(t, mailer, owner, 'member@lists.test', 'member')).client;
  viewer = (await inviteAndJoin(t, mailer, owner, 'viewer@lists.test', 'viewer')).client;
  outsider = await signUpVerified(t, mailer, 'outsider@lists.test', 'Oscar Outsider');
  await createWorkspace(outsider, 'Ailleurs');
  // Tracked before the test clock (2026-10-14T12:00Z) so "new since last run" can drop to 0.
  const before = new Date('2026-10-14T10:00:00Z');
  await track(
    'salon',
    { displayName: 'Salon Belle Mèche', locality: 'Gustavia' },
    {
      pipelineStatus: 'qualified',
      createdAt: before,
    },
  );
  await track(
    'formula',
    { displayName: '=HYPERLINK("http://evil.example")', locality: 'Lorient' },
    {
      createdAt: before,
    },
  );
  const untracked = aBusiness();
  ids.untracked = untracked.id;
  await db.insert(businesses).values(untracked);
});

afterAll(async () => {
  await t?.close();
});

describe('saved searches', () => {
  it('keeps private searches to their creator and shares workspace ones read-only', async () => {
    const mine = await owner
      .post('/v1/saved-searches', { name: 'Qualified', filters: { status: ['qualified'] }, sort: '-score' })
      .expect(201);
    expect(mine.body).toMatchObject({
      name: 'Qualified',
      visibility: 'private',
      filters: { status: ['qualified'] },
      sort: '-score',
      newMatches: 1,
      mine: true,
      lastRunAt: null,
    });
    const shared = await owner
      .post('/v1/saved-searches', { name: 'Everything', filters: {}, visibility: 'workspace' })
      .expect(201);
    const seen = (await member.get('/v1/saved-searches').expect(200)).body.items.map(
      (s: { name: string }) => s.name,
    );
    expect(seen).toEqual(['Everything']);
    await member.get(`/v1/saved-searches/${mine.body.id}`).expect(404);
    expect((await member.get(`/v1/saved-searches/${shared.body.id}`).expect(200)).body.mine).toBe(false);
    await member.patch(`/v1/saved-searches/${shared.body.id}`, { name: 'Mine now' }).expect(403);
    await member.delete(`/v1/saved-searches/${shared.body.id}`).expect(403);
    await viewer.post('/v1/saved-searches', { name: 'Nope', filters: {} }).expect(403);
    await outsider.get(`/v1/saved-searches/${shared.body.id}`).expect(404);
    const renamed = await owner
      .patch(`/v1/saved-searches/${shared.body.id}`, { name: 'All tracked' })
      .expect(200);
    expect(renamed.body.name).toBe('All tracked');
    await owner.delete(`/v1/saved-searches/${mine.body.id}`).expect(204);
    await owner.get(`/v1/saved-searches/${mine.body.id}`).expect(404);
  });

  it('counts new matches until the search is run', async () => {
    const search = await owner
      .post('/v1/saved-searches', { name: 'Gustavia', filters: { q: 'Mèche' } })
      .expect(201);
    expect(search.body.newMatches).toBe(1);
    const run = await owner.post(`/v1/saved-searches/${search.body.id}/run`).expect(200);
    expect(run.body.newMatches).toBe(1);
    const after = await owner.get(`/v1/saved-searches/${search.body.id}`).expect(200);
    expect(after.body).toMatchObject({ newMatches: 0, lastRunAt: '2026-10-14T12:00:00.000Z' });
  });

  it('validates names, filters and pages', async () => {
    await owner.post('/v1/saved-searches', { name: '', filters: {} }).expect(422);
    await owner.post('/v1/saved-searches', { name: 'x', filters: { colour: 'red' } }).expect(422);
    await owner.post('/v1/saved-searches', { name: 'x', filters: { status: 'nope' } }).expect(422);
    await owner.patch('/v1/saved-searches/0192a1b2-0000-7000-8000-000000000999', {}).expect(422);
    const first = await owner.get('/v1/saved-searches?limit=1').expect(200);
    expect(first.body.items).toHaveLength(1);
    const next = await owner
      .get(`/v1/saved-searches?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .expect(200);
    expect(next.body.items[0].id).not.toBe(first.body.items[0].id);
    await owner.get('/v1/saved-searches?cursor=garbage').expect(422);
  });
});

describe('lists', () => {
  it('manages lists and their tracked businesses in bulk', async () => {
    const list = await member.post('/v1/lists', { name: 'Prospects', description: 'Hot leads' }).expect(201);
    expect(list.body).toMatchObject({ name: 'Prospects', itemCount: 0 });
    await owner.post('/v1/lists', { name: 'Prospects' }).expect(409);
    const added = await member
      .post(`/v1/lists/${list.body.id}/items`, {
        businessIds: [ids.salon, ids.formula, ids.salon, ids.untracked],
      })
      .expect(200);
    expect(added.body).toEqual({ changed: 2, unchanged: 0, notTracked: [ids.untracked], itemCount: 2 });
    const again = await member
      .post(`/v1/lists/${list.body.id}/items`, { businessIds: [ids.salon] })
      .expect(200);
    expect(again.body).toMatchObject({ changed: 0, unchanged: 1, itemCount: 2 });
    const listed = await viewer.get(`/v1/businesses?list=${list.body.id}`).expect(200);
    expect(listed.body.items.map((i: { id: string }) => i.id).sort()).toEqual(
      [ids.salon, ids.formula].sort(),
    );
    const removed = await member
      .post(`/v1/lists/${list.body.id}/items/remove`, { businessIds: [ids.formula, ids.untracked] })
      .expect(200);
    expect(removed.body).toMatchObject({ changed: 1, unchanged: 1, itemCount: 1 });
    await viewer.post(`/v1/lists/${list.body.id}/items`, { businessIds: [ids.salon] }).expect(403);
    await outsider.get(`/v1/lists/${list.body.id}`).expect(404);
    expect((await outsider.get(`/v1/businesses?list=${list.body.id}`).expect(200)).body.items).toEqual([]);
    const other = await owner.post('/v1/lists', { name: 'Other' }).expect(201);
    await owner.patch(`/v1/lists/${other.body.id}`, { name: 'Prospects' }).expect(409);
    expect(
      (await owner.get('/v1/lists').expect(200)).body.items.map((l: { name: string }) => l.name),
    ).toEqual(['Other', 'Prospects']);
    await owner.delete(`/v1/lists/${other.body.id}`).expect(204);
    await owner.get(`/v1/lists/${other.body.id}`).expect(404);
    await member
      .post(`/v1/lists/${list.body.id}/items`, { businessIds: Array.from({ length: 1001 }, () => ids.salon) })
      .expect(422);
  });
});

describe('GET /v1/businesses/export.csv', () => {
  const lines = (text: string) => text.replace(/^﻿/, '').trim().split('\r\n');

  it('streams the listing with contacts for outreach users, neutralizes formulas and audits', async () => {
    const res = await owner.get('/v1/businesses/export.csv?sort=name').expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toContain('businesses.csv');
    const [header, ...rows] = lines(res.text);
    expect(header?.split(',')).toEqual(expect.arrayContaining(['id', 'name', 'phone', 'email']));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.organizationId, org), eq(auditLogs.action, 'business.exported')));
    expect(entry?.metadata).toMatchObject({ rows: 2, sort: 'name' });
  });

  it('selects columns and keeps contacts from users who cannot contact businesses', async () => {
    const res = await viewer.get('/v1/businesses/export.csv?fields=name,status&status=qualified').expect(200);
    expect(lines(res.text)).toEqual(['name,status', 'Salon Belle Mèche,qualified']);
    const defaults = await viewer.get('/v1/businesses/export.csv').expect(200);
    expect(lines(defaults.text)[0]).not.toMatch(/email|phone/);
    await viewer.get('/v1/businesses/export.csv?fields=name,email').expect(403);
    await viewer.get('/v1/businesses/export.csv?area=0192a1b2-0000-7000-8000-000000000999').expect(404);
    await t.http.get('/v1/businesses/export.csv').expect(401);
  });
});
