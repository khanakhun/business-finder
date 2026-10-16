import { fixedClock } from '@bf/contracts';
import type { DbClient } from '@bf/db';
import {
  auditLogs,
  businesses,
  businessRatingObservations,
  businessReviews,
  enrichmentSteps,
  orgBusinesses,
  reviewInsights,
} from '@bf/db/schema';
import { aBusiness } from '@bf/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestWorker, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import {
  type Browser,
  createWorkspace,
  inviteAndJoin,
  signUpVerified,
} from '../../../test/identity-helpers.ts';
import { NightlyMaintenance } from '../enrichment/index.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';
import { VALKEY } from '../platform/valkey/valkey.module.ts';
import {
  REVIEW_CLASSIFIER,
  REVIEW_SUBJECTS,
  type ReviewClassifier,
  type ReviewSubject,
  type ReviewSubjectReader,
} from './application/ports.ts';
import { ReviewMiningService } from './application/review-mining.service.ts';
import type { PreparedReview, ReviewBatch } from './domain/review.ts';
import {
  FakeReviewClassifier,
  ValkeyReviewClassificationCache,
} from './infrastructure/review-classifiers.ts';

// Review mining (BF-029) end to end: HTTP app + worker on real Postgres and Valkey, with the fake review sources and a
// recording fake classifier (FAKE_REVIEWS). Asserts the licensing gates, that review text and reviewer names never
// reach the model or storage, the owner acknowledgement in the audit log, concurrency, workspace isolation and
// retention. App and worker share one clock, started at real time and moved forward by the tests.

const mailer = new FakeMailer();
const ENV = {
  FAKE_REVIEWS: 'true',
  FAKE_SITE_INTEL: 'true',
  FAKE_EMAIL_VERIFIER: 'true',
  FAKE_CONNECTION_TESTS: 'true',
};
const DAY_MS = 86_400_000;
const GOOGLE_KEY = `AIza${'Q'.repeat(31)}Zx9w`;
const clock = fixedClock(new Date());

/** Everything the classifier was asked, to prove it only sees anonymized text. */
const classified: PreparedReview[] = [];
const fake = new FakeReviewClassifier();
const recording: ReviewClassifier = {
  classify: (org, reviews) => {
    classified.push(...reviews);
    return fake.classify(org, reviews);
  },
  forget: async () => {},
};
const OVERRIDES = [{ token: REVIEW_CLASSIFIER, value: recording }];

let t: TestApp;
let worker: INestApplicationContext;
let db: DbClient;
let owner: Browser;
let admin: Browser;
let viewer: Browser;
let outsider: Browser;
let org: string;
let outsiderOrg: string;

async function track(name: string, organizationId = org): Promise<string> {
  const business = aBusiness({ displayName: name, ratingAvg: 4.1, ratingCount: 30 });
  await db.insert(businesses).values(business);
  await db.insert(orgBusinesses).values({ organizationId, businessId: business.id, addedVia: 'search' });
  return business.id;
}

async function subjectOf(id: string): Promise<ReviewSubject> {
  return (await t.app.get<ReviewSubjectReader>(REVIEW_SUBJECTS).find(id)) as ReviewSubject;
}

const batch = (
  source: ReviewBatch['source'],
  text = 'Impossible to book a table, nobody answers.',
): ReviewBatch => ({
  source,
  reviews: [{ text, rating: 2, ownerResponded: null, knownNames: [] }],
  rating: null,
  fetchedAt: clock.now(),
  costUsd: 0,
});

async function enrichReviews(client: Browser, businessId: string) {
  await client
    .post(`/v1/businesses/${businessId}/enrich`)
    .send({ steps: ['reviews'], force: true })
    .expect(201);
  await expect
    .poll(
      async () =>
        (await client.get(`/v1/businesses/${businessId}/enrichment`).expect(200)).body.latestRun?.status,
      { timeout: 30_000, interval: 100 },
    )
    .toMatch(/^(completed|partially_completed|failed|cancelled)$/);
  const run = (await client.get(`/v1/businesses/${businessId}/enrichment`).expect(200)).body.latestRun;
  return run.steps.find((s: { step: string }) => s.step === 'reviews');
}

/** Google on for the workspace: the owner's acknowledgement (audit rows a second apart) and a Places key. */
async function enableGoogle() {
  clock.advance(1_000);
  await owner.post('/v1/reviews/sources/google/acknowledgement').send({ termsVersion: 1 }).expect(200);
  await owner.put('/v1/workspace/secrets/google_places', { value: GOOGLE_KEY }).expect(200);
}

async function revokeGoogle(client: Browser = owner) {
  clock.advance(1_000);
  await client.delete('/v1/reviews/sources/google/acknowledgement').expect(200);
}

/** Every place review content could leak to: insights rows, step outputs, audit metadata (as text). */
async function stored(businessId: string): Promise<string> {
  const rows = await Promise.all([
    db.select().from(reviewInsights).where(eq(reviewInsights.businessId, businessId)),
    db
      .select({ ref: enrichmentSteps.outputRef })
      .from(enrichmentSteps)
      .where(eq(enrichmentSteps.businessId, businessId)),
    db.select({ metadata: auditLogs.metadata }).from(auditLogs).where(eq(auditLogs.organizationId, org)),
  ]);
  return JSON.stringify(rows);
}

const LEAKS = ['Impossible to book online', 'answers the phone', 'Alex', 'Fictif', 'Jordan'];

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 16, env: ENV, clock, overrides: OVERRIDES });
  db = t.app.get(DB_CLIENT);
  worker = await createTestWorker(t, { mailer, env: ENV, clock, overrides: OVERRIDES });
  owner = await signUpVerified(t, mailer, 'owner@reviews.test', 'Rita Owner');
  org = await createWorkspace(owner, 'Agence Avis');
  admin = (await inviteAndJoin(t, mailer, owner, 'admin@reviews.test', 'admin')).client;
  viewer = (await inviteAndJoin(t, mailer, owner, 'viewer@reviews.test', 'viewer')).client;
  outsider = await signUpVerified(t, mailer, 'outsider@reviews.test', 'Oscar Outsider');
  outsiderOrg = await createWorkspace(outsider, 'Ailleurs');
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await t?.close();
});

describe('licensing gates', () => {
  it('skips the step with every source gate off and stores nothing', async () => {
    const id = await track('Chez Gates Off');
    const step = await enrichReviews(owner, id);
    expect(step).toMatchObject({ status: 'skipped', skipReason: 'licensing_disabled', costUsd: 0 });
    expect(await db.select().from(reviewInsights).where(eq(reviewInsights.businessId, id))).toEqual([]);
    const { body } = await owner.get(`/v1/businesses/${id}/review-insights`).expect(200);
    expect(body.insights).toBeNull();
    expect(body.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'google_places', effective: 'none', blockedBy: 'acknowledgement' }),
        expect.objectContaining({ source: 'gmaps_scraper', effective: 'none', blockedBy: 'not_enabled' }),
        expect.objectContaining({ source: 'manual', effective: 'transient_insights', blockedBy: null }),
      ]),
    );
  });

  it('lets only a signed-in owner acknowledge the Google terms, and records it in the audit log', async () => {
    const before = (await owner.get('/v1/reviews/sources').expect(200)).body;
    expect(before.googleAcknowledgement).toBeNull();
    expect(before.googleTerms.url).toMatch(/^https:\/\/cloud\.google\.com\/maps-platform\/terms/);
    await admin.post('/v1/reviews/sources/google/acknowledgement').send({ termsVersion: 1 }).expect(403);
    await viewer.get('/v1/reviews/sources').expect(403);
    await owner.post('/v1/reviews/sources/google/acknowledgement').send({ termsVersion: 0 }).expect(422);
    await owner.post('/v1/reviews/sources/google/acknowledgement').send({ termsVersion: 99 }).expect(403);

    clock.advance(1_000);
    const after = (
      await owner.post('/v1/reviews/sources/google/acknowledgement').send({ termsVersion: 1 }).expect(200)
    ).body;
    expect(after.googleAcknowledgement).toMatchObject({ termsVersion: 1 });
    // Acknowledged, but no Places key yet.
    expect(after.sources.find((s: { source: string }) => s.source === 'google_places')).toMatchObject({
      usage: 'transient_insights',
      effective: 'none',
      blockedBy: 'not_configured',
    });
    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.organizationId, org), eq(auditLogs.action, 'reviews.google_terms_acknowledged')),
      );
    expect(entry?.metadata).toMatchObject({
      termsVersion: 1,
      termsUrl: 'https://cloud.google.com/maps-platform/terms',
      termsLastModified: '2026-08-26',
    });
  });

  it('derives transient insights from Google reviews: no text, no reviewer, 30-day expiry', async () => {
    await enableGoogle();
    const id = await track('Le Bistrot Avis');
    classified.length = 0;
    const step = await enrichReviews(owner, id);
    expect(step).toMatchObject({ status: 'done' });
    // The fake Google source's paid call is booked.
    expect(step.costUsd).toBeCloseTo(0.025);

    const { body } = await viewer.get(`/v1/businesses/${id}/review-insights`).expect(200);
    expect(body.insights).toMatchObject({
      businessId: id,
      sources: ['google_places'],
      sampleSize: 5,
      // The fake classifier's keywords: "call three times" also reads as unreachable by phone.
      painCounts: { booking_friction: 1, unreachable_by_phone: 2 },
      ratingSnapshot: { avg: 3.4, count: 42 },
      ratingTrend: 'unknown',
    });
    expect(Date.parse(body.insights.expiresAt) - Date.parse(body.insights.computedAt)).toBe(30 * DAY_MS);
    const snippets = Object.values(body.insights.evidence).flat() as Array<{ sourceRef: string }>;
    expect(snippets.length).toBeGreaterThan(0);
    for (const snippet of snippets) expect(snippet.sourceRef).toBe('google_places');

    // The classifier only saw anonymized text; nothing of the reviews or their authors was stored.
    expect(classified).toHaveLength(5);
    const sent = JSON.stringify(classified);
    for (const leaked of ['Alex', 'Fictif', 'Jordan']) expect(sent).not.toContain(leaked);
    expect(sent).toContain('[person]');
    const text = await stored(id);
    for (const leaked of LEAKS) expect(text).not.toContain(leaked);
    expect(await db.select().from(businessReviews).where(eq(businessReviews.businessId, id))).toEqual([]);
    const observations = await db
      .select()
      .from(businessRatingObservations)
      .where(eq(businessRatingObservations.businessId, id));
    expect(observations.map((o) => o.source).sort()).toEqual(['golden_record', 'google_places']);
    expect(observations.every((o) => o.expiresAt !== null)).toBe(true);

    // Re-running replaces the Google contribution (not doubled) and adds no same-day observation.
    clock.advance(60_000);
    expect(await enrichReviews(owner, id)).toMatchObject({ status: 'done' });
    const again = (await owner.get(`/v1/businesses/${id}/review-insights`).expect(200)).body.insights;
    expect(again).toMatchObject({ sampleSize: 5, painCounts: { booking_friction: 1 } });
    const googleObservations = await db
      .select()
      .from(businessRatingObservations)
      .where(
        and(
          eq(businessRatingObservations.businessId, id),
          eq(businessRatingObservations.source, 'google_places'),
        ),
      );
    expect(googleObservations).toHaveLength(1);
  });

  it('forgets what Google gave when an admin turns it off, and stops using it', async () => {
    await enableGoogle();
    const id = await track('Chez Oubli');
    expect((await enrichReviews(owner, id)).status).toBe('done');
    await viewer.delete('/v1/reviews/sources/google/acknowledgement').expect(403);
    await revokeGoogle(admin);
    const status = (await owner.get('/v1/reviews/sources').expect(200)).body;
    expect(status.googleAcknowledgement).toBeNull();
    expect(await db.select().from(reviewInsights).where(eq(reviewInsights.businessId, id))).toEqual([]);
    expect(await enrichReviews(owner, id)).toMatchObject({
      status: 'skipped',
      skipReason: 'licensing_disabled',
    });
  });

  it('drops a contribution whose gate closed while it was being analysed', async () => {
    const id = await track('Chez Fermeture');
    const outcome = await t.app
      .get(ReviewMiningService)
      .analyze(org, await subjectOf(id), batch('google_places'), { allowed: async () => false });
    expect(outcome.analysed).toBe(0);
    expect(await db.select().from(reviewInsights).where(eq(reviewInsights.businessId, id))).toEqual([]);
  });

  it('keeps the scraper source off while the scraper itself is not allowed, and audits the choice', async () => {
    await viewer.put('/v1/reviews/sources', { gmapsScraper: 'transient_insights' }).expect(403);
    const { body } = await admin
      .put('/v1/reviews/sources', { gmapsScraper: 'transient_insights' })
      .expect(200);
    expect(body.sources.find((s: { source: string }) => s.source === 'gmaps_scraper')).toMatchObject({
      usage: 'transient_insights',
      effective: 'none',
      blockedBy: 'scraper_gates',
    });
    await admin.put('/v1/reviews/sources', { gmapsScraper: 'none' }).expect(200);
    const entries = await db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(and(eq(auditLogs.organizationId, org), eq(auditLogs.action, 'reviews.sources_updated')));
    expect(entries.map((e) => e.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: 'transient_insights' }),
        expect.objectContaining({ to: 'none' }),
      ]),
    );
  });
});

describe('pasted reviews', () => {
  const PASTE = {
    reviews: [
      {
        text: 'Impossible de réserver en ligne, merci Julie quand même. Écrivez à resa@chez-paste.example',
        rating: 2,
      },
      { text: 'Nobody answers the phone, call +33 1 99 00 12 34 and good luck.', rating: 1 },
      { text: 'Amazing view, best cocktails in Gustavia, highly recommend!', rating: 5 },
    ],
  };

  it('analyses them on the fly and keeps only aggregates; a new paste replaces the last one', async () => {
    const id = await track('Chez Paste');
    classified.length = 0;
    const { body } = await owner.post(`/v1/businesses/${id}/reviews/analyze`).send(PASTE).expect(200);
    expect(body.insights).toMatchObject({ sources: ['manual'], sampleSize: 3, expiresAt: null });
    // The fake classifier's keywords (the [email] placeholder reads as a written message).
    expect(body.insights.painCounts).toEqual({
      booking_friction: 1,
      unreachable_by_phone: 1,
      slow_or_no_reply: 1,
      positive_strong_reputation: 1,
    });
    const sent = JSON.stringify(classified);
    for (const leaked of ['Julie', 'resa@', '99 00 12']) expect(sent).not.toContain(leaked);
    const text = await stored(id);
    for (const fragment of ['Impossible de réserver', 'Julie', 'chez-paste', '99 00 12', 'Gustavia']) {
      expect(text).not.toContain(fragment);
    }
    expect(await db.select().from(businessReviews).where(eq(businessReviews.businessId, id))).toEqual([]);

    const again = await owner
      .post(`/v1/businesses/${id}/reviews/analyze`)
      .send({ reviews: [{ text: 'Waited 50 minutes for a table.', rating: 2 }] })
      .expect(200);
    expect(again.body.insights).toMatchObject({
      sources: ['manual'],
      sampleSize: 1,
      painCounts: { long_wait_times: 1 },
    });
    expect(again.body.insights.painCounts.booking_friction).toBeUndefined();
  });

  it('validates the paste and enforces roles and workspaces', async () => {
    const id = await track('Chez Droits');
    await admin.post(`/v1/businesses/${id}/reviews/analyze`).send({ reviews: [] }).expect(422);
    await admin
      .post(`/v1/businesses/${id}/reviews/analyze`)
      .send({ reviews: [{ text: 'x'.repeat(2_001) }] })
      .expect(422);
    await admin
      .post(`/v1/businesses/${id}/reviews/analyze`)
      .send({ reviews: [{ text: 'ok', rating: 6 }] })
      .expect(422);
    await viewer.post(`/v1/businesses/${id}/reviews/analyze`).send(PASTE).expect(403);
    await outsider.post(`/v1/businesses/${id}/reviews/analyze`).send(PASTE).expect(404);
    await outsider.get(`/v1/businesses/${id}/review-insights`).expect(404);
    await owner.get('/v1/businesses/00000000-0000-7000-8000-000000000000/review-insights').expect(404);
  });

  it('keeps each workspace’s insights apart', async () => {
    const id = await track('Chez Partage');
    await admin.post(`/v1/businesses/${id}/reviews/analyze`).send(PASTE).expect(200);
    await db
      .insert(orgBusinesses)
      .values({ organizationId: outsiderOrg, businessId: id, addedVia: 'search' });
    expect((await outsider.get(`/v1/businesses/${id}/review-insights`).expect(200)).body.insights).toBeNull();
    await outsider
      .post(`/v1/businesses/${id}/reviews/analyze`)
      .send({ reviews: [{ text: 'Waited an hour.' }] })
      .expect(200);
    const mine = (await admin.get(`/v1/businesses/${id}/review-insights`).expect(200)).body.insights;
    expect(mine).toMatchObject({ sampleSize: 3 });
  });
});

describe('concurrency', () => {
  it('keeps both contributions when two sources merge at once into a new row', async () => {
    const mining = t.app.get(ReviewMiningService);
    for (let i = 0; i < 8; i++) {
      const id = await track(`Chez Course ${i}`);
      const subject = await subjectOf(id);
      await Promise.all([
        mining.analyze(org, subject, batch('google_places')),
        mining.analyze(org, subject, batch('manual', 'Waited forever for a coffee.')),
      ]);
      const [row] = await db.select().from(reviewInsights).where(eq(reviewInsights.businessId, id));
      expect(row?.sources.sort()).toEqual(['google_places', 'manual']);
      expect(row?.sampleSize).toBe(2);
    }
  });
});

describe('retention', () => {
  it('shows the live part once Google expires, and the nightly purge removes the rest', async () => {
    await enableGoogle();
    const id = await track('Chez Expire');
    expect((await enrichReviews(owner, id)).status).toBe('done');
    await owner
      .post(`/v1/businesses/${id}/reviews/analyze`)
      .send({ reviews: [{ text: 'Waited an hour, nobody apologised.', rating: 2 }] })
      .expect(200);
    const [row] = await db.select().from(reviewInsights).where(eq(reviewInsights.businessId, id));
    expect(row?.sources.sort()).toEqual(['google_places', 'manual']);
    expect(row?.expiresAt).not.toBeNull();

    // Past the Google expiry, before the purge: the pasted part is still shown, Google's is not.
    clock.set(new Date((row?.expiresAt ?? new Date()).getTime() + 60_000));
    const shown = (await owner.get(`/v1/businesses/${id}/review-insights`).expect(200)).body.insights;
    expect(shown).toMatchObject({ sources: ['manual'], sampleSize: 1, expiresAt: null });
    expect(JSON.stringify(shown.evidence)).not.toContain('google_places');

    const purge = worker.get(NightlyMaintenance).all().get('review_insights_retention');
    expect(purge).toBeDefined();
    await purge?.(clock.now());
    const [after] = await db.select().from(reviewInsights).where(eq(reviewInsights.businessId, id));
    expect(after?.sources).toEqual(['manual']);
    expect(Object.keys(after?.sourceStats ?? {})).toEqual(['manual']);
    expect(after?.expiresAt).toBeNull();
    expect(JSON.stringify(after?.evidence)).not.toContain('google_places');
    expect(
      await db.select().from(businessRatingObservations).where(eq(businessRatingObservations.businessId, id)),
    ).toEqual([]);
    await revokeGoogle();
  });
});

describe('classification cache (Valkey)', () => {
  it('round-trips verdicts with a TTL, per workspace and source, and forgets a source', async () => {
    const valkey = t.app.get<Redis>(VALKEY);
    const cache = new ValkeyReviewClassificationCache(valkey);
    const verdict = {
      tags: ['booking_friction' as const],
      sentiment: -0.5,
      mentionsOwnerResponse: false,
      evidence: 'Booking is hard.',
      model: 'm',
      promptVersion: 1,
    };
    await cache.setMany(
      'org-a',
      new Map([
        ['google_places:h1', verdict],
        ['manual:h2', verdict],
      ]),
      60,
    );
    expect((await cache.getMany('org-a', ['google_places:h1', 'manual:h2', 'manual:h3'])).size).toBe(2);
    expect((await cache.getMany('org-b', ['google_places:h1'])).size).toBe(0);
    expect(await valkey.ttl('bf:reviews:verdict:org-a:google_places:h1')).toBeGreaterThan(0);
    await valkey.set('bf:reviews:verdict:org-a:manual:corrupt', '{not json');
    expect((await cache.getMany('org-a', ['manual:corrupt'])).size).toBe(0);
    await cache.forget('org-a', 'google_places');
    expect([...(await cache.getMany('org-a', ['google_places:h1', 'manual:h2'])).keys()]).toEqual([
      'manual:h2',
    ]);
  });
});
