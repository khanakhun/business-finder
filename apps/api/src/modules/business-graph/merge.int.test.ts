import type { SourceRecordInput } from '@bf/contracts';
import { type DbClient, runInTransaction } from '@bf/db';
import { businesses, businessSources, orgBusinesses, outboxEvents, possibleDuplicates } from '@bf/db/schema';
import { loadTaxonomy, seedTaxonomy } from '@bf/db/seed';
import { and, eq, sql } from 'drizzle-orm';
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
import { IngestSourceRecordCommand } from './application/resolution/ingest-source-record.command.ts';

const mailer = new FakeMailer();
let t: TestApp;
let db: DbClient;
let ingest: IngestSourceRecordCommand;
let owner: Browser;
let viewer: Browser;
let outsider: Browser;
let ownerOrg: string;

/** Two records of probably the same place: same area and name, no shared phone or site. */
function lookAlikes(n: number) {
  const lat = 17.9 + n * 0.01;
  const lng = -62.84 - n * 0.01;
  const a: SourceRecordInput = {
    provider: 'google_places',
    providerRef: `mg-${n}`,
    fetchedAt: '2026-10-01T10:00:00.000Z',
    name: `La Cabane ${n}`,
    providerCategories: [{ key: 'restaurant' }],
    location: { lat, lng },
    phones: [`+590590${String(300000 + n).slice(-6)}`],
    rating: 4.2,
    reviewCount: 80,
  };
  const b: SourceRecordInput = {
    provider: 'foursquare',
    providerRef: `mf-${n}`,
    fetchedAt: '2026-10-02T10:00:00.000Z',
    name: `Cabane ${n}`,
    location: { lat: lat + 0.0003, lng },
    website: `https://cabane-${n}.com`,
    emails: [`hello@cabane-${n}.com`],
  };
  return { a, b };
}

async function pair(n: number) {
  const { a, b } = lookAlikes(n);
  const first = await ingest.execute(a);
  const second = await ingest.execute(b);
  expect(second).toMatchObject({ outcome: 'possible_duplicate', possibleDuplicates: [first.businessId] });
  return { a: first.businessId, b: second.businessId };
}

const row = async (id: string) => (await db.select().from(businesses).where(eq(businesses.id, id)))[0];

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 15 });
  db = t.app.get(DB_CLIENT);
  ingest = t.app.get(IngestSourceRecordCommand);
  await runInTransaction(db, (tx) => seedTaxonomy(tx, loadTaxonomy()));
  owner = await signUpVerified(t, mailer, 'owner@merge.test', 'Olive Owner');
  ownerOrg = await createWorkspace(owner, 'Agence');
  viewer = (await inviteAndJoin(t, mailer, owner, 'viewer@merge.test', 'viewer')).client;
  outsider = await signUpVerified(t, mailer, 'outsider@merge.test', 'Other Owner');
  await createWorkspace(outsider, 'Elsewhere');
});

afterAll(async () => {
  await t?.close();
});

describe('possible duplicates', () => {
  it('lists pairs the workspace tracks entirely, with reasons; others see nothing', async () => {
    const { a, b } = await pair(1);
    await owner.post(`/v1/businesses/${a}/track`, {}).expect(201);
    await owner.post(`/v1/businesses/${b}/track`, {}).expect(201);
    await outsider.post(`/v1/businesses/${a}/track`, {}).expect(201);
    const list = await viewer.get('/v1/businesses/possible-duplicates').expect(200);
    const item = list.body.items.find((i: { businessA: { id: string } }) => [a, b].includes(i.businessA.id));
    expect(item).toMatchObject({
      status: 'open',
      reasons: { reasons: expect.arrayContaining([expect.stringMatching(/name/)]) },
    });
    expect([item.businessA.displayName, item.businessB.displayName].sort()).toEqual([
      'Cabane 1',
      'La Cabane 1',
    ]);
    expect((await outsider.get('/v1/businesses/possible-duplicates').expect(200)).body.items).toEqual([]);
    await outsider.patch(`/v1/businesses/possible-duplicates/${item.id}`, { action: 'dismiss' }).expect(404);
    await viewer.patch(`/v1/businesses/possible-duplicates/${item.id}`, { action: 'dismiss' }).expect(403);
    await owner.patch(`/v1/businesses/possible-duplicates/${item.id}`, { action: 'dismiss' }).expect(204);
    await owner.patch(`/v1/businesses/possible-duplicates/${item.id}`, { action: 'dismiss' }).expect(422);
    const dismissed = await owner.get('/v1/businesses/possible-duplicates?status=dismissed').expect(200);
    expect(dismissed.body.items.map((i: { id: string }) => i.id)).toContain(item.id);
  });

  it('merges a pair, re-pointing sources and workspace links, and keeps the further pipeline status', async () => {
    const { a, b } = await pair(2);
    await owner.post(`/v1/businesses/${a}/track`, {}).expect(201);
    await owner.post(`/v1/businesses/${b}/track`, {}).expect(201);
    await db
      .update(orgBusinesses)
      .set({ pipelineStatus: 'contacted', doNotContact: true })
      .where(and(eq(orgBusinesses.organizationId, ownerOrg), eq(orgBusinesses.businessId, b)));
    const [dup] = await db
      .select()
      .from(possibleDuplicates)
      .where(sql`${possibleDuplicates.businessAId} IN (${a}, ${b})`);
    await owner
      .patch(`/v1/businesses/possible-duplicates/${dup?.id}`, { action: 'merge', survivorId: a })
      .expect(204);

    expect((await row(b))?.mergedIntoId).toBe(a);
    const sources = await db.select().from(businessSources).where(eq(businessSources.businessId, a));
    expect(sources.map((s) => s.providerRef).sort()).toEqual(['mf-2', 'mg-2']);
    const survivor = await row(a);
    // Survivorship across both: Google's name and phone, Foursquare's website.
    expect(survivor).toMatchObject({ displayName: 'La Cabane 2', websiteRegistrableDomain: 'cabane-2.com' });
    const links = await db.select().from(orgBusinesses).where(eq(orgBusinesses.organizationId, ownerOrg));
    expect(links.filter((l) => l.businessId === b)).toEqual([]);
    expect(links.find((l) => l.businessId === a)).toMatchObject({
      pipelineStatus: 'contacted',
      doNotContact: true,
    });
    expect(
      (
        await db
          .select()
          .from(possibleDuplicates)
          .where(eq(possibleDuplicates.id, dup?.id as string))
      )[0]?.status,
    ).toBe('merged');
    const merged = await db
      .select()
      .from(outboxEvents)
      .where(
        and(eq(outboxEvents.type, 'business.merged'), sql`${outboxEvents.payload}->>'businessId' = ${b}`),
      );
    expect(merged).toHaveLength(1);
    // Merged records are read-only.
    await owner.post('/v1/businesses/merge', { survivorId: a, mergedIds: [b] }).expect(404);
  });
});

describe('manual adds', () => {
  it('a manual add never joins a record other workspaces rely on, but joins one the workspace alone tracks', async () => {
    const { a: shared } = await pair(6);
    await outsider.post(`/v1/businesses/${shared}/track`, {}).expect(201);
    const sharedRow = await row(shared);
    const body = {
      displayName: 'La Cabane 6 (corrigé)',
      countryCode: 'BL',
      location: sharedRow?.location,
      phone: sharedRow?.primaryPhoneE164,
    };
    const created = await owner.post('/v1/businesses', body).expect(201);
    expect(created.body.id).not.toBe(shared);
    expect((await row(shared))?.displayName).toBe('La Cabane 6');

    const { a: mine } = await pair(7);
    await owner.post(`/v1/businesses/${mine}/track`, {}).expect(201);
    const mineRow = await row(mine);
    const joined = await owner
      .post('/v1/businesses', {
        ...body,
        displayName: 'La Cabane 7 (corrigé)',
        location: mineRow?.location,
        phone: mineRow?.primaryPhoneE164,
      })
      .expect(201);
    expect(joined.body.id).toBe(mine);
    expect(joined.body.displayName).toBe('La Cabane 7 (corrigé)');
  });
});

describe('merge and split', () => {
  it('round-trips: merge then split restores the separated golden values', async () => {
    const { a, b } = await pair(3);
    await owner.post(`/v1/businesses/${a}/track`, {}).expect(201);
    await owner.post(`/v1/businesses/${b}/track`, {}).expect(201);
    const golden = (r: Awaited<ReturnType<typeof row>>) => ({
      displayName: r?.displayName,
      phone: r?.primaryPhoneE164,
      website: r?.websiteUrl,
      rating: r?.ratingAvg,
      location: r?.location,
    });
    const before = { a: golden(await row(a)), b: golden(await row(b)) };

    const merge = await owner.post('/v1/businesses/merge', { survivorId: a, mergedIds: [b] }).expect(200);
    expect(merge.body).toEqual({ survivorId: a, mergedIds: [b], sourcesMoved: 1 });
    const [bSource] = await db.select().from(businessSources).where(eq(businessSources.providerRef, 'mf-3'));

    const split = await owner.post(`/v1/businesses/${a}/split`, { sourceIds: [bSource?.id] }).expect(201);
    expect(split.body).toMatchObject({ businessId: a, sourcesMoved: 1 });
    const c = split.body.newBusinessId as string;
    expect(golden(await row(a))).toEqual(before.a);
    expect(golden(await row(c))).toEqual(before.b);
    // The workspace that saw the merged record also tracks the split-off one.
    await owner.get(`/v1/businesses/${c}`).expect(200);
  });

  it('refuses to merge or split businesses another workspace also tracks', async () => {
    const { a, b } = await pair(5);
    await owner.post(`/v1/businesses/${a}/track`, {}).expect(201);
    await owner.post(`/v1/businesses/${b}/track`, {}).expect(201);
    await outsider.post(`/v1/businesses/${b}/track`, {}).expect(201);
    const refused = await owner.post('/v1/businesses/merge', { survivorId: a, mergedIds: [b] }).expect(403);
    expect(refused.body).toMatchObject({ reason: 'BUSINESS_SHARED' });
    const [source] = await db.select().from(businessSources).where(eq(businessSources.businessId, b));
    await owner.post(`/v1/businesses/${b}/split`, { sourceIds: [source?.id] }).expect(403);
    expect((await row(b))?.mergedIntoId).toBeNull();
  });

  it('validates merges and splits and scopes them to tracked businesses', async () => {
    const { a, b } = await pair(4);
    await owner.post(`/v1/businesses/${a}/track`, {}).expect(201);
    await owner.post('/v1/businesses/merge', { survivorId: a, mergedIds: [b] }).expect(404);
    await owner.post(`/v1/businesses/${b}/track`, {}).expect(201);
    await owner.post('/v1/businesses/merge', { survivorId: a, mergedIds: [a] }).expect(422);
    await viewer.post('/v1/businesses/merge', { survivorId: a, mergedIds: [b] }).expect(403);
    const sources = await db.select().from(businessSources).where(eq(businessSources.businessId, a));
    await owner.post(`/v1/businesses/${a}/split`, { sourceIds: sources.map((s) => s.id) }).expect(422);
    await owner
      .post(`/v1/businesses/${a}/split`, { sourceIds: ['019a0000-0000-7000-8000-000000000000'] })
      .expect(422);
    await outsider.post(`/v1/businesses/${a}/split`, { sourceIds: [sources[0]?.id] }).expect(404);
  });
});
