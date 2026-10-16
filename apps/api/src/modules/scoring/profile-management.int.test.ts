import type { DbClient } from '@bf/db';
import { businesses, businessScores, orgBusinesses } from '@bf/db/schema';
import { aBusiness } from '@bf/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { and, count, eq } from 'drizzle-orm';
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
import { BUILTIN_PRIMARY_PROFILE_ID, BUILTIN_PROFILE_IDS } from './application/builtin-profiles.seeder.ts';
import { ScoringService } from './application/scoring.service.ts';

// Workspace scoring profiles (BF-032) end to end: duplicate a built-in, version, activate (the workspace recomputes
// through the outbox), rename, archive; the editor's preview sample and batch explain.

const mailer = new FakeMailer();
let t: TestApp;
let worker: INestApplicationContext;
let db: DbClient;
let owner: Browser;
let member: Browser;
let outsider: Browser;
let org: string;
const tracked: string[] = [];

const scoresFor = async (profileId: string, version?: number) =>
  (
    await db
      .select({ n: count() })
      .from(businessScores)
      .where(
        and(
          eq(businessScores.organizationId, org),
          eq(businessScores.profileId, profileId),
          ...(version ? [eq(businessScores.profileVersion, version)] : []),
        ),
      )
  )[0]?.n ?? 0;

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 19 });
  db = t.app.get(DB_CLIENT);
  worker = await createTestWorker(t, { mailer });
  owner = await signUpVerified(t, mailer, 'owner@profiles.test', 'Ada Owner');
  org = await createWorkspace(owner, 'Agence Profils');
  ({ client: member } = await inviteAndJoin(t, mailer, owner, 'member@profiles.test', 'member'));
  outsider = await signUpVerified(t, mailer, 'outsider@profiles.test', 'Oscar Outsider');
  await createWorkspace(outsider, 'Ailleurs');
  const made = Array.from({ length: 6 }, (_, i) =>
    aBusiness({ websiteUrl: null, websiteHost: null, websiteRegistrableDomain: null, ratingCount: 20 * i }),
  );
  await db.insert(businesses).values(made);
  await db
    .insert(orgBusinesses)
    .values(made.map((b) => ({ organizationId: org, businessId: b.id, addedVia: 'import' as const })));
  tracked.push(...made.map((b) => b.id));
  await t.app.get(ScoringService).compute(org, tracked, { notify: false });
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await t?.close();
});

describe('workspace scoring profiles', () => {
  let profileId = '';

  it('duplicates a built-in: version 1 active, scored for the workspace through the outbox', async () => {
    const { body } = await owner
      .post('/v1/scoring/profiles')
      .send({ fromProfileId: BUILTIN_PROFILE_IDS.local_seo, name: 'Local SEO (ours)' })
      .expect(201);
    expect(body).toMatchObject({
      offer: 'local_seo',
      name: 'Local SEO (ours)',
      builtin: false,
      activeVersion: 1,
      primary: false,
      archived: false,
    });
    profileId = body.id;
    const list = (await owner.get('/v1/scoring/profiles').expect(200)).body.items;
    expect(list.map((p: { id: string }) => p.id)).toContain(profileId);
    await expect.poll(() => scoresFor(profileId), { timeout: 20_000, interval: 200 }).toBe(tracked.length);
    // Another workspace never sees it.
    await outsider.get(`/v1/scoring/profiles/${profileId}/versions`).expect(404);
  });

  it('saves versions (same offer only), activates one, and the workspace recomputes with it', async () => {
    const v1 = (await owner.get(`/v1/scoring/profiles/${profileId}/versions/1`).expect(200)).body.config;
    const changed = { ...v1, weights: { ...v1.weights, tourism_facing: 30 } };
    const { body } = await owner
      .post(`/v1/scoring/profiles/${profileId}/versions`)
      .send({ config: changed })
      .expect(201);
    expect(body).toEqual({ version: 2 });
    await owner
      .post(`/v1/scoring/profiles/${profileId}/versions`)
      .send({ config: { ...changed, offer: 'booking_system' } })
      .expect(422);
    // Saving does not activate.
    expect((await owner.get(`/v1/scoring/profiles/${profileId}/versions`).expect(200)).body.items).toEqual([
      { version: 2, active: false, createdAt: expect.any(String) },
      { version: 1, active: true, createdAt: expect.any(String) },
    ]);
    const activated = await owner
      .post(`/v1/scoring/profiles/${profileId}/activate`)
      .send({ version: 2 })
      .expect(202);
    expect(activated.body).toMatchObject({ id: profileId, activeVersion: 2 });
    await expect.poll(() => scoresFor(profileId, 2), { timeout: 20_000, interval: 200 }).toBe(tracked.length);
    await owner.post(`/v1/scoring/profiles/${profileId}/activate`).send({ version: 9 }).expect(404);
  });

  it('refuses changes to built-ins, and editing for members', async () => {
    const config = (
      await owner.get(`/v1/scoring/profiles/${BUILTIN_PROFILE_IDS.local_seo}/versions/1`).expect(200)
    ).body.config;
    await owner
      .post(`/v1/scoring/profiles/${BUILTIN_PROFILE_IDS.local_seo}/versions`)
      .send({ config })
      .expect(409);
    await owner
      .patch(`/v1/scoring/profiles/${BUILTIN_PROFILE_IDS.local_seo}`)
      .send({ name: 'Mine' })
      .expect(409);
    await member
      .post('/v1/scoring/profiles')
      .send({ fromProfileId: BUILTIN_PROFILE_IDS.local_seo, name: 'Nope' })
      .expect(403);
    await member.post(`/v1/scoring/profiles/${profileId}/activate`).send({ version: 1 }).expect(403);
    // Members still read versions.
    await member.get(`/v1/scoring/profiles/${profileId}/versions`).expect(200);
  });

  it('renames and archives (an archived profile is no longer scored; the primary cannot be archived)', async () => {
    await owner.patch(`/v1/scoring/profiles/${profileId}`).send({ name: 'Renamed' }).expect(200);
    await owner.put('/v1/scoring/primary-profile').send({ profileId }).expect(202);
    await owner.patch(`/v1/scoring/profiles/${profileId}`).send({ archived: true }).expect(409);
    await owner
      .put('/v1/scoring/primary-profile')
      .send({ profileId: BUILTIN_PRIMARY_PROFILE_ID })
      .expect(202);
    const { body } = await owner
      .patch(`/v1/scoring/profiles/${profileId}`)
      .send({ archived: true })
      .expect(200);
    expect(body).toMatchObject({ name: 'Renamed', archived: true });
    await owner.post(`/v1/scoring/profiles/${profileId}/activate`).send({ version: 1 }).expect(409);
    // Five built-ins scored, not the archived one.
    expect((await t.app.get(ScoringService).compute(org, [tracked[0] ?? ''], { notify: false })).scored).toBe(
      5,
    );
    const listed = (await owner.get('/v1/scoring/profiles').expect(200)).body.items.find(
      (p: { id: string }) => p.id === profileId,
    );
    expect(listed).toMatchObject({ archived: true, name: 'Renamed' });
  });
});

describe('profile editor preview', () => {
  it('samples the workspace’s businesses with their current tier for a profile', async () => {
    const { body } = await owner
      .get('/v1/scoring/preview-sample')
      .query({ profileId: BUILTIN_PRIMARY_PROFILE_ID, size: 4 })
      .expect(200);
    expect(body.items).toHaveLength(4);
    for (const item of body.items) expect(tracked).toContain(item.businessId);
    expect(body.items[0]).toMatchObject({ displayName: expect.any(String), tier: expect.any(String) });
    await owner
      .get('/v1/scoring/preview-sample')
      .query({ profileId: BUILTIN_PRIMARY_PROFILE_ID, size: 500 })
      .expect(422);
    await member
      .get('/v1/scoring/preview-sample')
      .query({ profileId: BUILTIN_PRIMARY_PROFILE_ID })
      .expect(403);
  });

  it('scores a batch with a draft config server-side, leaving untracked businesses out', async () => {
    const config = {
      offer: 'new_website',
      weights: { has_website: -10, rating_avg: 0, has_phone: 20 },
      tiers: { A: 60, B: 30 },
    };
    const draft = { ...config, weights: { has_phone: 20 } };
    const { body } = await owner
      .post('/v1/scoring/explain/batch')
      .send({ config: draft, businessIds: [...tracked, crypto.randomUUID()] })
      .expect(200);
    expect(body.items.map((item: { businessId: string }) => item.businessId).sort()).toEqual(
      [...tracked].sort(),
    );
    expect(body.items[0]).toMatchObject({ score: expect.any(Number), tier: expect.any(String) });
    const tooMany = Array.from({ length: 51 }, () => crypto.randomUUID());
    await owner.post('/v1/scoring/explain/batch').send({ config: draft, businessIds: tooMany }).expect(422);
    await member.post('/v1/scoring/explain/batch').send({ config: draft, businessIds: tracked }).expect(403);
    // Nothing stored.
    expect(await scoresFor(BUILTIN_PRIMARY_PROFILE_ID)).toBe(tracked.length);
  });
});
