import { OFFERS } from '@bf/contracts';
import type { DbClient } from '@bf/db';
import { activities, businesses, businessScoreHistory, businessScores, orgBusinesses } from '@bf/db/schema';
import { aBusiness } from '@bf/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { and, count, eq, sql } from 'drizzle-orm';
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
import { RecomputeRunner } from './application/scoring.use-cases.ts';

// Scoring (BF-031) end to end: HTTP app + worker on real Postgres and Valkey. Tracking a business scores it (event →
// job → facts → engine → scores, history, the listing's score/tier); a do-not-contact flag or a pipeline move
// recomputes it; bulk recomputes page through a workspace.

const mailer = new FakeMailer();
// No fixed clock: the outbox relay compares the database's real time with the app's (a past clock delays events).
let t: TestApp;
let worker: INestApplicationContext;
let db: DbClient;
let owner: Browser;
let member: Browser;
let outsider: Browser;
let org: string;

/** A business in the graph (no website: the new-website profile likes it), tracked through the API. */
async function trackNew(overrides: Parameters<typeof aBusiness>[0] = {}): Promise<string> {
  const business = aBusiness({
    websiteUrl: null,
    websiteHost: null,
    websiteRegistrableDomain: null,
    ...overrides,
  });
  await db.insert(businesses).values(business);
  await owner.post(`/v1/businesses/${business.id}/track`).send({ addedVia: 'search' }).expect(201);
  return business.id;
}

const scoresOf = async (businessId: string) =>
  (await owner.get(`/v1/businesses/${businessId}/scores`).expect(200)).body.items as {
    profileId: string;
    tier: string;
    score: number;
    reasons: { text: { en: string } }[];
    contributions: { feature: string; imputed: string | null }[];
    features: Record<string, unknown>;
  }[];

/** Scores stored for a business (polled from the database: the HTTP API is rate-limited). */
const storedScores = async (businessId: string) =>
  (
    await db
      .select({ n: count() })
      .from(businessScores)
      .where(and(eq(businessScores.organizationId, org), eq(businessScores.businessId, businessId)))
  )[0]?.n ?? 0;

const listing = async (businessId: string) => {
  const [row] = await db
    .select({ score: orgBusinesses.score, tier: orgBusinesses.tier, profileId: orgBusinesses.scoreProfileId })
    .from(orgBusinesses)
    .where(and(eq(orgBusinesses.organizationId, org), eq(orgBusinesses.businessId, businessId)));
  return row;
};

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 18 });
  db = t.app.get(DB_CLIENT);
  worker = await createTestWorker(t, { mailer });
  owner = await signUpVerified(t, mailer, 'owner@scoring.test', 'Ada Owner');
  org = await createWorkspace(owner, 'Agence Score');
  ({ client: member } = await inviteAndJoin(t, mailer, owner, 'member@scoring.test', 'member'));
  outsider = await signUpVerified(t, mailer, 'outsider@scoring.test', 'Oscar Outsider');
  await createWorkspace(outsider, 'Ailleurs');
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await t?.close();
});

describe('scoring', () => {
  it('lists the built-in profiles, new website primary, with their versions', async () => {
    const { body } = await owner.get('/v1/scoring/profiles').expect(200);
    expect(body.items.map((p: { offer: string }) => p.offer).sort()).toEqual([...OFFERS].sort());
    expect(body.items.find((p: { primary: boolean }) => p.primary)).toMatchObject({
      id: BUILTIN_PRIMARY_PROFILE_ID,
      offer: 'new_website',
      builtin: true,
      activeVersion: 1,
    });
    const version = await owner
      .get(`/v1/scoring/profiles/${BUILTIN_PROFILE_IDS.local_seo}/versions/1`)
      .expect(200);
    expect(version.body).toMatchObject({ version: 1, config: { offer: 'local_seo', kind: 'rules' } });
    await owner.get(`/v1/scoring/profiles/${BUILTIN_PROFILE_IDS.local_seo}/versions/9`).expect(404);
  });

  it('scores a business when it is tracked: every profile, history, and the listing’s score and tier', async () => {
    const id = await trackNew({ ratingCount: 300, ratingAvg: 4.6 });
    await expect.poll(() => storedScores(id), { timeout: 20_000, interval: 200 }).toBe(5);
    const scores = await scoresOf(id);
    const primary = scores.find((score) => score.profileId === BUILTIN_PRIMARY_PROFILE_ID);
    expect(primary?.features).toMatchObject({ has_website: false, website_status: 'none' });
    expect(primary?.reasons.length).toBeGreaterThan(0);
    expect(await listing(id)).toEqual({
      score: primary?.score,
      tier: primary?.tier,
      profileId: BUILTIN_PRIMARY_PROFILE_ID,
    });
    const [history] = await db
      .select({ n: count() })
      .from(businessScoreHistory)
      .where(and(eq(businessScoreHistory.organizationId, org), eq(businessScoreHistory.businessId, id)));
    expect(history?.n).toBe(5);
    // The same facts again change nothing (idempotent on the feature vector and versions).
    const again = await t.app.get(ScoringService).compute(org, [id]);
    expect(again).toEqual({ scored: 5, written: 0, unchanged: 5 });
    // History is append-only: an UPDATE is refused by the database.
    await expect(
      db.execute(sql`UPDATE business_score_history SET score = 1 WHERE business_id = ${id}`),
    ).rejects.toThrow();
  });

  it('recomputes on do-not-contact: tier X, on the listing and the timeline', async () => {
    const id = await trackNew({ ratingCount: 300, ratingAvg: 4.6 });
    await expect
      .poll(async () => (await listing(id))?.tier ?? null, { timeout: 20_000, interval: 200 })
      .not.toBeNull();
    const before = (await listing(id))?.tier;
    await owner
      .put(`/v1/businesses/${id}/do-not-contact`)
      .send({ doNotContact: true, reason: 'Asked us to stop' })
      .expect(200);
    await expect.poll(async () => (await listing(id))?.tier, { timeout: 20_000, interval: 200 }).toBe('X');
    expect((await listing(id))?.score).toBe(0);
    // A tier change of the primary profile is on the timeline.
    await expect
      .poll(
        async () =>
          (
            await db
              .select({ data: activities.data })
              .from(activities)
              .where(and(eq(activities.businessId, id), eq(activities.type, 'score.updated')))
          ).map((row) => row.data),
        { timeout: 20_000, interval: 200 },
      )
      .toEqual([expect.objectContaining({ from: before, to: 'X', offer: 'new_website' })]);
  });

  it('recomputes on a pipeline move (disqualified → X) and on shared facts for every workspace tracking it', async () => {
    const id = await trackNew({ ratingCount: 120 });
    await expect.poll(() => storedScores(id), { timeout: 20_000, interval: 200 }).toBe(5);
    // Another workspace tracks it too.
    await outsider.post(`/v1/businesses/${id}/track`).send({ addedVia: 'search' }).expect(201);
    const featuresOf = async (organizationId: string) =>
      (
        await db
          .select({ features: businessScores.features })
          .from(businessScores)
          .where(
            and(
              eq(businessScores.organizationId, organizationId),
              eq(businessScores.businessId, id),
              eq(businessScores.profileId, BUILTIN_PRIMARY_PROFILE_ID),
            ),
          )
      )[0]?.features ?? {};
    const [other] = await db
      .select({ organizationId: orgBusinesses.organizationId })
      .from(orgBusinesses)
      .where(and(eq(orgBusinesses.businessId, id), sql`${orgBusinesses.organizationId} <> ${org}`));
    const otherOrg = other?.organizationId ?? '';
    await expect
      .poll(async () => (await featuresOf(otherOrg)).has_phone, { timeout: 20_000, interval: 200 })
      .toBe(false);
    // A shared fact changes (the golden record's reviews), then a contact is added (`business.updated`): every
    // tracking workspace recomputes; the hand-added phone is the adding workspace's own (ADR-0008).
    await db.update(businesses).set({ ratingCount: 999 }).where(eq(businesses.id, id));
    await owner
      .post(`/v1/businesses/${id}/contacts`)
      .send({ type: 'phone', value: '+590 590 27 00 00' })
      .expect(201);
    await expect
      .poll(async () => (await featuresOf(org)).has_phone, { timeout: 20_000, interval: 200 })
      .toBe(true);
    await expect
      .poll(async () => (await featuresOf(otherOrg)).review_count_log, { timeout: 20_000, interval: 200 })
      .toBe(3);
    expect((await featuresOf(otherOrg)).has_phone).toBe(false);
    // A pipeline move is the workspace's own.
    await owner
      .post(`/v1/businesses/${id}/status`)
      .send({ status: 'disqualified', reason: 'Not a fit' })
      .expect(200);
    await expect.poll(async () => (await listing(id))?.tier, { timeout: 20_000, interval: 200 }).toBe('X');
  });

  it('keeps workspaces apart and checks permissions', async () => {
    const id = await trackNew();
    await outsider.get(`/v1/businesses/${id}/scores`).expect(404);
    await outsider
      .post('/v1/scoring/explain')
      .send({
        businessId: id,
        config: { offer: 'new_website', weights: { has_phone: 10 }, tiers: { A: 60, B: 30 } },
      })
      .expect(404);
    await member.get(`/v1/businesses/${id}/scores`).expect(200);
    await member.post(`/v1/scoring/profiles/${BUILTIN_PRIMARY_PROFILE_ID}/recompute`).expect(403);
    await member
      .put('/v1/scoring/primary-profile')
      .send({ profileId: BUILTIN_PROFILE_IDS.local_seo })
      .expect(403);
    await member
      .post('/v1/scoring/explain')
      .send({
        businessId: id,
        config: { offer: 'new_website', weights: { has_phone: 10 }, tiers: { A: 60, B: 30 } },
      })
      .expect(403);
  });

  it('explains a draft config without storing anything, and refuses unusable ones', async () => {
    const id = await trackNew();
    await expect.poll(() => storedScores(id), { timeout: 20_000, interval: 200 }).toBe(5);
    const before = await db.select({ n: count() }).from(businessScoreHistory);
    const draft = {
      offer: 'local_seo',
      weights: { has_website: 10, has_phone: 30 },
      tiers: { A: 60, B: 30 },
    };
    const { body } = await owner
      .post('/v1/scoring/explain')
      .send({ businessId: id, config: draft })
      .expect(200);
    expect(body).toMatchObject({ featureSetVersion: 1, features: { has_website: false } });
    expect(body.contributions.map((c: { feature: string }) => c.feature)).toEqual([
      'has_website',
      'has_phone',
    ]);
    expect(await db.select({ n: count() }).from(businessScoreHistory)).toEqual(before);
    const bad = await owner
      .post('/v1/scoring/explain')
      .send({ businessId: id, config: { ...draft, weights: { rating_avg: 10 } } })
      .expect(422);
    expect(JSON.stringify(bad.body)).toContain('rating_avg');
  });

  it('switches the primary profile: the listing follows it at once, then a recompute fills the rest', async () => {
    const id = await trackNew({ ratingCount: 50 });
    await expect.poll(() => storedScores(id), { timeout: 20_000, interval: 200 }).toBe(5);
    const localSeo = (await scoresOf(id)).find((score) => score.profileId === BUILTIN_PROFILE_IDS.local_seo);
    const { body } = await owner
      .put('/v1/scoring/primary-profile')
      .send({ profileId: BUILTIN_PROFILE_IDS.local_seo })
      .expect(202);
    expect(body).toMatchObject({ profileId: BUILTIN_PROFILE_IDS.local_seo, version: 1 });
    expect(await listing(id)).toEqual({
      score: localSeo?.score,
      tier: localSeo?.tier,
      profileId: BUILTIN_PROFILE_IDS.local_seo,
    });
    expect(
      (await owner.get('/v1/scoring/profiles').expect(200)).body.items.find(
        (p: { primary: boolean }) => p.primary,
      ).id,
    ).toBe(BUILTIN_PROFILE_IDS.local_seo);
    await owner
      .put('/v1/scoring/primary-profile')
      .send({ profileId: BUILTIN_PRIMARY_PROFILE_ID })
      .expect(202);
    await owner
      .put('/v1/scoring/primary-profile')
      .send({ profileId: '01990000-0000-7000-8000-0000000000aa' })
      .expect(404);
  });

  it('recomputes a workspace in bulk: 10,000 businesses in under a minute', async () => {
    // A separate workspace with 10k synthetic businesses (no website, a few reviews), inserted in bulk.
    const bulk = await signUpVerified(t, mailer, 'bulk@scoring.test', 'Bea Bulk');
    const bulkOrg = await createWorkspace(bulk, 'Agence Bulk');
    await db.execute(sql`
      WITH made AS (
        INSERT INTO businesses (id, display_name, normalized_name, country_code, rating_avg, rating_count, operating_status)
        SELECT gen_random_uuid(), 'Bulk business ' || n, 'bulk business ' || n, 'BL', 3 + (n % 20) / 10.0, n % 400,
          'operational'
        FROM generate_series(1, 10000) AS n
        RETURNING id
      )
      INSERT INTO org_businesses (organization_id, business_id, added_via)
      SELECT ${bulkOrg}, id, 'import' FROM made`);
    const started = performance.now();
    const outcome = await t.app.get(RecomputeRunner).run(bulkOrg, BUILTIN_PRIMARY_PROFILE_ID, 1);
    const seconds = (performance.now() - started) / 1000;
    console.info(`BF-031 bulk recompute: ${outcome.done} businesses in ${seconds.toFixed(1)} s`);
    expect(outcome).toEqual({ done: 10_000, written: 10_000 });
    expect(seconds).toBeLessThan(60);
    const [scored] = await db
      .select({ n: count() })
      .from(businessScores)
      .where(
        and(
          eq(businessScores.organizationId, bulkOrg),
          eq(businessScores.profileId, BUILTIN_PRIMARY_PROFILE_ID),
        ),
      );
    expect(scored?.n).toBe(10_000);
    const [listed] = await db
      .select({ n: count() })
      .from(orgBusinesses)
      .where(and(eq(orgBusinesses.organizationId, bulkOrg), sql`${orgBusinesses.tier} IS NOT NULL`));
    expect(listed?.n).toBe(10_000);
  }, 120_000);
});
