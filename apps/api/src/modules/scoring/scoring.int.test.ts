import { OFFERS } from '@bf/contracts';
import type { DbClient } from '@bf/db';
import {
  activities,
  businesses,
  businessScoreHistory,
  businessScores,
  categories,
  orgBusinesses,
  outboxEvents,
  scoringProfiles,
  scoringProfileVersions,
} from '@bf/db/schema';
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
import {
  BUILTIN_PRIMARY_PROFILE_ID,
  BUILTIN_PROFILE_IDS,
  BuiltinProfilesSeeder,
} from './application/builtin-profiles.seeder.ts';
import {
  FACTS_ASSEMBLER,
  type FactsAssembler,
  SCORING_REPOSITORY,
  type ScoringRepository,
} from './application/ports.ts';
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
let outsiderOrg: string;

/** A business in the graph (no website: the new-website profile likes it), tracked through the API. */
async function trackNew(
  overrides: Parameters<typeof aBusiness>[0] = {},
  client: Browser = owner,
): Promise<string> {
  const business = aBusiness({
    websiteUrl: null,
    websiteHost: null,
    websiteRegistrableDomain: null,
    ...overrides,
  });
  await db.insert(businesses).values(business);
  await client.post(`/v1/businesses/${business.id}/track`).send({ addedVia: 'search' }).expect(201);
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

/** A crawl snapshot and its audit (only the parts scoring reads are meaningful). */
async function audited(
  businessId: string,
  audit: { status: string; quality: number | null; latest: boolean },
) {
  const snapshotId = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO website_snapshots (id, business_id, url, fetched_at, reachability, tls, security, languages, pages,
      contacts, socials, booking, ordering, chat, analytics, tech, freshness, mobile, performance_hints, links,
      no_solicitation, logo_candidates, image_candidates, warnings, content_hash)
    VALUES (${snapshotId}, ${businessId}, 'https://example.test/', now(), 'ok', '{}',
      '{"https": false, "hsts": false, "mixedContent": false}',
      '{"declared": [], "detected": [], "hreflang": [], "hasLanguageSwitcher": false}',
      '[{"kind": "booking", "url": "https://example.test/book"}]',
      '{"emails": [{"email": "x@example.test"}], "phones": [], "whatsappLinks": [], "contactForms": []}', '[]',
      '{"providers": []}', '{"providers": []}', '{"providers": []}',
      '{"ga4": false, "gtm": false, "metaPixel": true, "tiktokPixel": false, "others": []}', '[]',
      '{"copyrightYear": 2020, "httpLastModified": null, "sitemapLastmod": null, "latestDatedContent": null}',
      '{}', '{}', '{}', '{"checked": true, "detected": false, "phrases": [], "pageUrl": null, "snippet": null}',
      '[]', '[]', '[]', ${snapshotId})`);
  await db.execute(sql`
    INSERT INTO website_audits (id, business_id, snapshot_id, psi, vision, findings, quality_score, website_status,
      is_latest)
    VALUES (${crypto.randomUUID()}, ${businessId}, ${snapshotId},
      '{"mobile": {"scores": {"performance": 31}, "metrics": {"lcpMs": 5200}}, "desktop": null}', '{"overall": 4}',
      '[{"code": "no_https"}, {"code": "missing_english"}]', ${audit.quality}, ${audit.status}, ${audit.latest})`);
}

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
  outsiderOrg = await createWorkspace(outsider, 'Ailleurs');
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
    // tracking workspace recomputes; contacts are global facts (ADR-0008), the hand-added phone counts for both.
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
    expect((await featuresOf(otherOrg)).has_phone).toBe(true);
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
    // Its own workspace: the switch recomputes the whole workspace.
    const switcher = await signUpVerified(t, mailer, 'switch@scoring.test', 'Sam Switch');
    const switchOrg = await createWorkspace(switcher, 'Agence Switch');
    const id = await trackNew({ ratingCount: 50 }, switcher);
    // Another business with no scores yet (tracked without an event).
    const unscored = aBusiness({ websiteUrl: null, websiteHost: null, websiteRegistrableDomain: null });
    await db.insert(businesses).values(unscored);
    await db
      .insert(orgBusinesses)
      .values({ organizationId: switchOrg, businessId: unscored.id, addedVia: 'import' });
    const listed = async (businessId: string) =>
      (
        await db
          .select({
            score: orgBusinesses.score,
            tier: orgBusinesses.tier,
            profileId: orgBusinesses.scoreProfileId,
          })
          .from(orgBusinesses)
          .where(and(eq(orgBusinesses.organizationId, switchOrg), eq(orgBusinesses.businessId, businessId)))
      )[0];
    await expect
      .poll(async () => (await listed(id))?.profileId, { timeout: 20_000, interval: 200 })
      .toBe(BUILTIN_PRIMARY_PROFILE_ID);
    const [localSeo] = await db
      .select({ score: businessScores.score, tier: businessScores.tier })
      .from(businessScores)
      .where(
        and(
          eq(businessScores.organizationId, switchOrg),
          eq(businessScores.businessId, id),
          eq(businessScores.profileId, BUILTIN_PROFILE_IDS.local_seo),
        ),
      );
    const { body } = await switcher
      .put('/v1/scoring/primary-profile')
      .send({ profileId: BUILTIN_PROFILE_IDS.local_seo })
      .expect(202);
    expect(body).toMatchObject({ profileId: BUILTIN_PROFILE_IDS.local_seo, version: 1, total: 2 });
    // At once: the scores already there; nothing for the business without one.
    expect(await listed(id)).toEqual({ ...localSeo, profileId: BUILTIN_PROFILE_IDS.local_seo });
    expect(await listed(unscored.id)).toEqual({ score: null, tier: null, profileId: null });
    // Then the recompute (enqueued after the commit) fills it in.
    await expect
      .poll(async () => (await listed(unscored.id))?.profileId, { timeout: 20_000, interval: 200 })
      .toBe(BUILTIN_PROFILE_IDS.local_seo);
    const profiles = (await switcher.get('/v1/scoring/profiles').expect(200)).body.items;
    expect(profiles.find((p: { primary: boolean }) => p.primary).id).toBe(BUILTIN_PROFILE_IDS.local_seo);
    await switcher
      .put('/v1/scoring/primary-profile')
      .send({ profileId: '01990000-0000-7000-8000-0000000000aa' })
      .expect(404);
  });

  it('recomputes over HTTP through the queue: 202 with the total, then every tracked business scored', async () => {
    const owner2 = await signUpVerified(t, mailer, 'recompute@scoring.test', 'Rita Recompute');
    const org2 = await createWorkspace(owner2, 'Agence Recompute');
    const made = [
      aBusiness({ websiteUrl: null }),
      aBusiness({ websiteUrl: null }),
      aBusiness({ websiteUrl: null }),
    ];
    await db.insert(businesses).values(made);
    await db
      .insert(orgBusinesses)
      .values(made.map((b) => ({ organizationId: org2, businessId: b.id, addedVia: 'import' as const })));
    const profileId = BUILTIN_PROFILE_IDS.ai_receptionist;
    const { body } = await owner2.post(`/v1/scoring/profiles/${profileId}/recompute`).expect(202);
    expect(body).toEqual({ profileId, version: 1, total: 3 });
    const scoredFor = async () =>
      (
        await db
          .select({ n: count() })
          .from(businessScores)
          .where(and(eq(businessScores.organizationId, org2), eq(businessScores.profileId, profileId)))
      )[0]?.n;
    await expect.poll(scoredFor, { timeout: 20_000, interval: 200 }).toBe(3);
    // A version out of int4 range names no version.
    await owner2.get(`/v1/scoring/profiles/${profileId}/versions/99999999999`).expect(404);
  });

  it('keeps another workspace’s own profile out of reach, and never scores with it', async () => {
    const custom = crypto.randomUUID();
    const config = (
      await owner.get(`/v1/scoring/profiles/${BUILTIN_PROFILE_IDS.local_seo}/versions/1`).expect(200)
    ).body.config;
    const outsiderOrg = (await outsider.get('/v1/me').expect(200)).body.activeOrganization?.id as
      | string
      | undefined;
    const [anyOther] = await db
      .select({ organizationId: orgBusinesses.organizationId })
      .from(orgBusinesses)
      .where(sql`${orgBusinesses.organizationId} <> ${org}`)
      .limit(1);
    const theirOrg = outsiderOrg ?? anyOther?.organizationId ?? '';
    await db
      .insert(scoringProfiles)
      .values({ id: custom, organizationId: theirOrg, offer: 'local_seo', name: 'Theirs' });
    await db.insert(scoringProfileVersions).values({ profileId: custom, version: 1, config });
    await db.update(scoringProfiles).set({ activeVersion: 1 }).where(eq(scoringProfiles.id, custom));
    await owner.get(`/v1/scoring/profiles/${custom}/versions/1`).expect(404);
    await owner.post(`/v1/scoring/profiles/${custom}/recompute`).expect(404);
    await owner.put('/v1/scoring/primary-profile').send({ profileId: custom }).expect(404);
    const listed = (await owner.get('/v1/scoring/profiles').expect(200)).body.items.map(
      (p: { id: string }) => p.id,
    );
    expect(listed).not.toContain(custom);
    const id = await trackNew();
    const outcome = await t.app.get(ScoringService).compute(org, [id], { force: true, notify: false });
    expect(outcome.scored).toBe(5);
    // Versions are immutable.
    await expect(
      db.execute(sql`UPDATE scoring_profile_versions SET config = '{}' WHERE profile_id = ${custom}`),
    ).rejects.toThrow();
  });

  it('assembles the facts in bulk: inherited category, latest audit and crawl, shared domain, own insights', async () => {
    const root = crypto.randomUUID();
    const leaf = crypto.randomUUID();
    const slug = `t${Date.now()}`;
    await db.insert(categories).values([
      {
        id: root,
        slug,
        path: slug,
        labels: { en: 'Root', fr: 'Racine' },
        attributes: { tourismFacing: true, appointmentBased: false },
        offerRelevance: { booking_system: 0.2, local_seo: 0.7 },
      },
      {
        id: leaf,
        slug: `${slug}_leaf`,
        parentId: root,
        path: `${slug}.${slug}_leaf`,
        labels: { en: 'Leaf', fr: 'Feuille' },
        attributes: { appointmentBased: true },
        offerRelevance: { booking_system: 0.9 },
      },
    ]);
    const domain = `shared-${slug}.example`;
    const id = await trackNew({
      websiteUrl: `https://${domain}/`,
      websiteHost: domain,
      websiteRegistrableDomain: domain,
    });
    await db.update(businesses).set({ primaryCategoryId: leaf }).where(eq(businesses.id, id));
    const sibling = aBusiness({
      websiteUrl: `https://${domain}/b`,
      websiteHost: domain,
      websiteRegistrableDomain: domain,
    });
    await db.insert(businesses).values(sibling);
    await audited(id, { status: 'ok', quality: 80, latest: false });
    await audited(id, { status: 'weak', quality: 41, latest: true });
    await db.execute(sql`
      INSERT INTO review_insights (organization_id, business_id, computed_at, sources, sample_size, pain_counts,
        pain_share, sentiment_avg, owner_response_rate, evidence, source_stats, model, prompt_version)
      VALUES (${org}, ${id}, now(), ARRAY['pasted'], 12, '{}', '{"booking_friction": 0.25}', -0.2, 0.1, '{}', '{}',
        'fake', 1)`);
    await owner.post(`/v1/businesses/${id}/status`).send({ status: 'qualified' }).expect(200);
    await owner.post(`/v1/businesses/${id}/status`).send({ status: 'contacted' }).expect(200);
    const assembler = t.app.get<FactsAssembler>(FACTS_ASSEMBLER);
    const [facts, ...rest] = await assembler.assemble(org, [id, crypto.randomUUID()], new Date());
    // A business the workspace does not track is left out.
    expect(rest).toEqual([]);
    expect(facts).toMatchObject({
      businessId: id,
      business: { sharedWebsiteCount: 2, websiteUrl: `https://${domain}/` },
      // Root first, the leaf overriding it.
      category: {
        attributes: { tourismFacing: true, appointmentBased: true },
        offerRelevance: { booking_system: 0.9, local_seo: 0.7 },
      },
      // The latest audit only, and its crawl (crawled e-mails are never part of the facts).
      audit: {
        status: 'weak',
        qualityScore: 41,
        psiMobilePerformance: 31,
        lcpMobileMs: 5200,
        visionOverall: 4,
        findingCodes: ['no_https', 'missing_english'],
      },
      site: { reachability: 'ok', analytics: { metaPixel: true }, contacts: { emails: [] } },
      reviews: {
        sampleSize: 12,
        painShare: { booking_friction: 0.25 },
        sentimentAvg: -0.2,
        ownerResponseRate: 0.1,
      },
      workspace: { pipelineStatus: 'contacted', lastContactedAt: expect.any(String) },
    });
    // Another workspace reads its own insights and pipeline (none here).
    const theirOrg = outsiderOrg;
    await db
      .insert(orgBusinesses)
      .values({ organizationId: theirOrg, businessId: id, addedVia: 'import' })
      .onConflictDoNothing();
    const [theirs] = await assembler.assemble(theirOrg, [id], new Date());
    expect(theirs?.reviews).toBeNull();
    expect(theirs?.workspace.lastContactedAt).toBeNull();
  });

  it('serializes concurrent computes for a business: one current row per profile, history once', async () => {
    const id = await trackNew({ ratingCount: 77 });
    await expect.poll(() => storedScores(id), { timeout: 20_000, interval: 200 }).toBe(5);
    await db.update(businesses).set({ ratingCount: 78 }).where(eq(businesses.id, id));
    const scoring = t.app.get(ScoringService);
    const results = await Promise.all([
      scoring.compute(org, [id], { notify: false }),
      scoring.compute(org, [id], { notify: false }),
      scoring.compute(org, [id], { force: true, notify: false }),
    ]);
    // Exactly one of the jobs wrote the new vector's history; the others found it written.
    expect(results.map((r) => r.scored)).toEqual([5, 5, 5]);
    expect(await storedScores(id)).toBe(5);
    const [history] = await db
      .select({ n: count() })
      .from(businessScoreHistory)
      .where(and(eq(businessScoreHistory.organizationId, org), eq(businessScoreHistory.businessId, id)));
    expect(history?.n).toBe(10);
  });

  it('emits org_business.tracked once, however often a business is tracked', async () => {
    const id = await trackNew();
    await owner.post(`/v1/businesses/${id}/track`).send({ addedVia: 'search' }).expect(200);
    const [tracked] = await db
      .select({ n: count() })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.type, 'org_business.tracked'),
          sql`${outboxEvents.payload}->>'businessId' = ${id}`,
        ),
      );
    expect(tracked?.n).toBe(1);
  });

  it('seeds the built-in profiles idempotently; a newer version activates and is never rolled back', async () => {
    const seeder = t.app.get(BuiltinProfilesSeeder);
    await seeder.seed();
    await seeder.seed();
    const [builtins] = await db
      .select({ n: count() })
      .from(scoringProfiles)
      .where(eq(scoringProfiles.builtin, true));
    expect(builtins?.n).toBe(5);
    const repository = t.app.get<ScoringRepository>(SCORING_REPOSITORY);
    const config = (
      await owner.get(`/v1/scoring/profiles/${BUILTIN_PROFILE_IDS.local_seo}/versions/1`).expect(200)
    ).body.config;
    const base = {
      id: BUILTIN_PROFILE_IDS.local_seo,
      offer: 'local_seo' as const,
      name: 'Local SEO',
      config,
    };
    try {
      // A newer version activates, with its event in the outbox (every workspace then recomputes); an older
      // process never rolls it back.
      expect(await seeder.ensure([{ ...base, version: 2 }])).toEqual([{ profileId: base.id, version: 2 }]);
      const [activated] = await db
        .select({ n: count() })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.type, 'scoring.profile_version.activated'),
            sql`${outboxEvents.payload}->>'profileId' = ${base.id}`,
            sql`${outboxEvents.payload}->>'version' = '2'`,
          ),
        );
      expect(activated?.n).toBe(1);
      expect(await repository.ensureBuiltins([{ ...base, version: 1 }])).toEqual([]);
      const [row] = await db
        .select({ version: scoringProfiles.activeVersion })
        .from(scoringProfiles)
        .where(eq(scoringProfiles.id, base.id));
      expect(row?.version).toBe(2);
    } finally {
      // Back to v1 for the other tests (the v2 row stays: versions are never rewritten).
      await db.update(scoringProfiles).set({ activeVersion: 1 }).where(eq(scoringProfiles.id, base.id));
    }
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
