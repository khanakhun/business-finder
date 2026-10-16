import type { DbClient } from '@bf/db';
import {
  businesses,
  businessScores,
  orgBusinesses,
  scoringProfiles,
  scoringProfileVersions,
} from '@bf/db/schema';
import { aBusiness } from '@bf/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { and, asc, count, eq, max } from 'drizzle-orm';
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
// through the outbox), rename, archive; the editor's preview sample and batch explain. Caps are lowered (3 unarchived
// profiles, 4 versions) so the tests reach them. The describes run in order and share the profile they create.
// Throttle budget (per user per minute): the owner's profile creates are exactly at the route's 5; add none.

const mailer = new FakeMailer();
let t: TestApp;
let worker: INestApplicationContext;
let db: DbClient;
let owner: Browser;
let member: Browser;
let outsider: Browser;
let org: string;
const tracked: string[] = [];
let outsiderBusiness = '';
const BUILTINS = Object.keys(BUILTIN_PROFILE_IDS).length;

/** The workspace's score rows (business, profile, score, time) in a stable order. */
const snapshot = () =>
  db
    .select({
      businessId: businessScores.businessId,
      profileId: businessScores.profileId,
      score: businessScores.score,
      computedAt: businessScores.computedAt,
    })
    .from(businessScores)
    .where(eq(businessScores.organizationId, org))
    .orderBy(asc(businessScores.businessId), asc(businessScores.profileId));

const lastComputed = async (profileId: string) =>
  (
    await db
      .select({ at: max(businessScores.computedAt) })
      .from(businessScores)
      .where(and(eq(businessScores.organizationId, org), eq(businessScores.profileId, profileId)))
  )[0]?.at ?? null;

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
  t = await createTestApp({
    mailer,
    valkeyDb: 19,
    env: { SCORING_MAX_WORKSPACE_PROFILES: '3', SCORING_MAX_PROFILE_VERSIONS: '4' },
  });
  db = t.app.get(DB_CLIENT);
  worker = await createTestWorker(t, { mailer });
  owner = await signUpVerified(t, mailer, 'owner@profiles.test', 'Ada Owner');
  org = await createWorkspace(owner, 'Agence Profils');
  ({ client: member } = await inviteAndJoin(t, mailer, owner, 'member@profiles.test', 'member'));
  outsider = await signUpVerified(t, mailer, 'outsider@profiles.test', 'Oscar Outsider');
  const elsewhere = await createWorkspace(outsider, 'Ailleurs');
  const made = Array.from({ length: 6 }, (_, i) =>
    aBusiness({ websiteUrl: null, websiteHost: null, websiteRegistrableDomain: null, ratingCount: 20 * i }),
  );
  await db.insert(businesses).values(made);
  await db
    .insert(orgBusinesses)
    .values(made.map((b) => ({ organizationId: org, businessId: b.id, addedVia: 'import' as const })));
  tracked.push(...made.map((b) => b.id));
  await t.app.get(ScoringService).compute(org, tracked, { notify: false });
  const theirs = aBusiness({ websiteUrl: null, websiteHost: null, websiteRegistrableDomain: null });
  await db.insert(businesses).values(theirs);
  await db
    .insert(orgBusinesses)
    .values({ organizationId: elsewhere, businessId: theirs.id, addedVia: 'import' as const });
  outsiderBusiness = theirs.id;
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
    // Another workspace never sees it, nor starts from it.
    await outsider.get(`/v1/scoring/profiles/${profileId}/versions`).expect(404);
    await outsider.post('/v1/scoring/profiles').send({ fromProfileId: profileId, name: 'Taken' }).expect(404);
  });

  it('saves versions (same offer only), activates one, and the workspace recomputes with it', async () => {
    const v1 = (await owner.get(`/v1/scoring/profiles/${profileId}/versions/1`).expect(200)).body.config;
    const changed = { ...v1, weights: { ...v1.weights, tourism_facing: 30 } };
    const { body } = await owner
      .post(`/v1/scoring/profiles/${profileId}/versions`)
      .send({ config: changed })
      .expect(201);
    expect(body).toEqual({ version: 2 });
    const mismatch = await owner
      .post(`/v1/scoring/profiles/${profileId}/versions`)
      .send({ config: { ...changed, offer: 'booking_system' } })
      .expect(422);
    expect(mismatch.body.errors).toEqual([{ path: ['config', 'offer'], message: 'Expected local_seo' }]);
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
    await member.patch(`/v1/scoring/profiles/${profileId}`).send({ name: 'Nope' }).expect(403);
    await member
      .post(`/v1/scoring/profiles/${profileId}/versions`)
      .send({ config: { offer: 'local_seo', weights: { has_phone: 1 }, tiers: { A: 60, B: 30 } } })
      .expect(403);
    // Members still read versions.
    await member.get(`/v1/scoring/profiles/${profileId}/versions`).expect(200);
  });

  it('refuses another workspace every change to the profile', async () => {
    const config = (await owner.get(`/v1/scoring/profiles/${profileId}/versions/1`).expect(200)).body.config;
    await outsider.patch(`/v1/scoring/profiles/${profileId}`).send({ name: 'Mine' }).expect(404);
    await outsider.post(`/v1/scoring/profiles/${profileId}/versions`).send({ config }).expect(404);
    await outsider.post(`/v1/scoring/profiles/${profileId}/activate`).send({ version: 1 }).expect(404);
    await outsider.get('/v1/scoring/preview-sample').query({ profileId }).expect(404);
    expect(
      (await owner.get(`/v1/scoring/profiles/${profileId}/versions`).expect(200)).body.items,
    ).toHaveLength(2);
  });

  it('numbers concurrent saves apart, and caps the versions of a profile', async () => {
    const config = (await owner.get(`/v1/scoring/profiles/${profileId}/versions/1`).expect(200)).body.config;
    const saves = await Promise.all([
      owner.post(`/v1/scoring/profiles/${profileId}/versions`).send({ config }).expect(201),
      owner.post(`/v1/scoring/profiles/${profileId}/versions`).send({ config }).expect(201),
    ]);
    expect(saves.map((save) => save.body.version).sort()).toEqual([3, 4]);
    await owner.post(`/v1/scoring/profiles/${profileId}/versions`).send({ config }).expect(409);
    const versions = (await owner.get(`/v1/scoring/profiles/${profileId}/versions`).expect(200)).body.items;
    expect(versions.map((v: { version: number }) => v.version)).toEqual([4, 3, 2, 1]);
  });

  it('caps the profiles a workspace creates, also under concurrent creates', async () => {
    await owner
      .post('/v1/scoring/profiles')
      .send({ fromProfileId: BUILTIN_PROFILE_IDS.booking_system, name: 'Second' })
      .expect(201);
    // One place left: of two creates at once, one gets it.
    const racing = await Promise.all(
      ['Third', 'Third bis'].map((name) =>
        owner.post('/v1/scoring/profiles').send({ fromProfileId: BUILTIN_PROFILE_IDS.booking_system, name }),
      ),
    );
    expect(racing.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(racing.find((response) => response.status === 409)?.body.detail).toMatch(/at most 3 of its own/);
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
    const archivedAt = (await db.select().from(scoringProfiles).where(eq(scoringProfiles.id, profileId)))[0]
      ?.archivedAt;
    expect(archivedAt).toBeInstanceOf(Date);
    // Archiving again keeps the first time.
    await owner.patch(`/v1/scoring/profiles/${profileId}`).send({ archived: true }).expect(200);
    expect(
      (await db.select().from(scoringProfiles).where(eq(scoringProfiles.id, profileId)))[0]?.archivedAt,
    ).toEqual(archivedAt);
    await owner.post(`/v1/scoring/profiles/${profileId}/activate`).send({ version: 1 }).expect(409);
    // Neither primary nor recomputed while archived.
    await owner.put('/v1/scoring/primary-profile').send({ profileId }).expect(409);
    await owner.post(`/v1/scoring/profiles/${profileId}/recompute`).expect(409);
    // The built-ins and the two other workspace profiles are scored, not the archived one.
    const scored = await t.app.get(ScoringService).compute(org, [tracked[0] ?? ''], { notify: false });
    expect(scored.scored).toBe(BUILTINS + 2);
    const listed = (await owner.get('/v1/scoring/profiles').expect(200)).body.items.find(
      (p: { id: string }) => p.id === profileId,
    );
    expect(listed).toMatchObject({ archived: true, name: 'Renamed' });
    // Its last scores are no longer shown on the business.
    const shown = (await owner.get(`/v1/businesses/${tracked[0]}/scores`).expect(200)).body.items;
    expect(shown.map((score: { profileId: string }) => score.profileId)).not.toContain(profileId);
  });

  it('unarchives within the cap: the workspace is scored with the profile again', async () => {
    // Archived, it left room for another; unarchiving would pass the cap until that one is archived.
    const fourth = await owner
      .post('/v1/scoring/profiles')
      .send({ fromProfileId: BUILTIN_PROFILE_IDS.booking_system, name: 'Fourth' })
      .expect(201);
    const refused = await owner
      .patch(`/v1/scoring/profiles/${profileId}`)
      .send({ archived: false })
      .expect(409);
    expect(refused.body.detail).toMatch(/archive one first/);
    await owner.patch(`/v1/scoring/profiles/${fourth.body.id}`).send({ archived: true }).expect(200);
    const before = await lastComputed(profileId);
    await owner.patch(`/v1/scoring/profiles/${profileId}`).send({ archived: false }).expect(200);
    await expect
      .poll(async () => (await lastComputed(profileId))?.getTime() ?? 0, { timeout: 20_000, interval: 200 })
      .toBeGreaterThan(before?.getTime() ?? 0);
    const shown = (await owner.get(`/v1/businesses/${tracked[0]}/scores`).expect(200)).body.items;
    expect(shown.map((score: { profileId: string }) => score.profileId)).toContain(profileId);
  });
});

describe('stored versions', () => {
  it('reads a saved version that rules added since would refuse', async () => {
    const [own] = await db
      .select()
      .from(scoringProfiles)
      .where(eq(scoringProfiles.organizationId, org))
      .limit(1);
    if (!own) throw new Error('no workspace profile');
    const v1 = (await owner.get(`/v1/scoring/profiles/${own.id}/versions/1`).expect(200)).body.config;
    // As saved before the placeholder check existed (stored versions are immutable).
    const legacy = {
      ...v1,
      reasonTemplates: { has_phone: { true: { en: 'Has a phone', fr: 'A un {numero}' } } },
    };
    await db
      .insert(scoringProfileVersions)
      .values({ profileId: own.id, version: 50, config: legacy, createdBy: null });
    const { body } = await owner.get(`/v1/scoring/profiles/${own.id}/versions/50`).expect(200);
    expect(body.config.reasonTemplates.has_phone.true.fr).toBe('A un {numero}');
    // A new version with the same text is refused.
    await owner.post(`/v1/scoring/profiles/${own.id}/versions`).send({ config: legacy }).expect(422);
  });
});

describe('business scores', () => {
  it('recomputes one business on demand (members may; another workspace gets 404)', async () => {
    const id = tracked[1] ?? '';
    const before = await lastComputed(BUILTIN_PRIMARY_PROFILE_ID);
    const { body } = await member.post(`/v1/businesses/${id}/scores/recompute`).expect(200);
    expect(body.items.length).toBeGreaterThanOrEqual(BUILTINS);
    const primary = body.items.find(
      (score: { profileId: string }) => score.profileId === BUILTIN_PRIMARY_PROFILE_ID,
    );
    expect(new Date(primary.computedAt).getTime()).toBeGreaterThan(before?.getTime() ?? 0);
    await outsider.post(`/v1/businesses/${id}/scores/recompute`).expect(404);
  });
});

describe('profile editor preview', () => {
  it('samples the workspace’s businesses with their current tier for a profile', async () => {
    // A merged duplicate the workspace still tracks is never sampled.
    const merged = aBusiness({
      websiteUrl: null,
      websiteHost: null,
      websiteRegistrableDomain: null,
      mergedIntoId: tracked[0] ?? null,
    });
    await db.insert(businesses).values(merged);
    await db
      .insert(orgBusinesses)
      .values({ organizationId: org, businessId: merged.id, addedVia: 'import' as const });
    const all = (
      await owner
        .get('/v1/scoring/preview-sample')
        .query({ profileId: BUILTIN_PRIMARY_PROFILE_ID })
        .expect(200)
    ).body.items.map((item: { businessId: string }) => item.businessId);
    expect([...all].sort()).toEqual([...tracked].sort());
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
    // Settled first: the profile tests' recomputes have finished writing (two reads apart are the same).
    let previous = '';
    await expect
      .poll(
        async () => {
          const now = JSON.stringify(await snapshot());
          const same = now === previous;
          previous = now;
          return same;
        },
        { timeout: 20_000, interval: 500 },
      )
      .toBe(true);
    const stored = await snapshot();
    const { body } = await owner
      .post('/v1/scoring/explain/batch')
      .send({ config: draft, businessIds: [...tracked, tracked[0], outsiderBusiness, crypto.randomUUID()] })
      .expect(200);
    expect(body.items.map((item: { businessId: string }) => item.businessId).sort()).toEqual(
      [...tracked].sort(),
    );
    expect(body.items[0]).toMatchObject({ score: expect.any(Number), tier: expect.any(String) });
    const tooMany = Array.from({ length: 51 }, () => crypto.randomUUID());
    await owner.post('/v1/scoring/explain/batch').send({ config: draft, businessIds: tooMany }).expect(422);
    await member.post('/v1/scoring/explain/batch').send({ config: draft, businessIds: tracked }).expect(403);
    // Nothing stored.
    expect(await snapshot()).toEqual(stored);
    // Another workspace's draft never reads this workspace's businesses.
    const theirs = await outsider
      .post('/v1/scoring/explain/batch')
      .send({ config: draft, businessIds: tracked })
      .expect(200);
    expect(theirs.body.items).toEqual([]);
  });
});
