import type { DbClient } from '@bf/db';
import {
  auditLogs,
  businesses,
  businessRatingObservations,
  businessReviews,
  orgBusinesses,
  reviewInsights,
} from '@bf/db/schema';
import { aBusiness } from '@bf/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
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

// Review mining (BF-029) end to end: HTTP app + worker on real Postgres and Valkey, with the fake review sources and
// classifier (FAKE_REVIEWS). Asserts the licensing gates, that review text and reviewer names are never persisted,
// the owner acknowledgement in the audit log, workspace isolation and the retention purge.

const mailer = new FakeMailer();
const ENV = {
  FAKE_REVIEWS: 'true',
  FAKE_SITE_INTEL: 'true',
  FAKE_EMAIL_VERIFIER: 'true',
  FAKE_CONNECTION_TESTS: 'true',
};
const DAY_MS = 86_400_000;
let t: TestApp;
let worker: INestApplicationContext;
let db: DbClient;
let owner: Browser;
let admin: Browser;
let viewer: Browser;
let outsider: Browser;
let org: string;

async function track(name: string, organizationId = org): Promise<string> {
  const business = aBusiness({ displayName: name, ratingAvg: 4.1, ratingCount: 30 });
  await db.insert(businesses).values(business);
  await db.insert(orgBusinesses).values({ organizationId, businessId: business.id, addedVia: 'search' });
  return business.id;
}

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

/** Everything stored about the business's reviews, as text (to look for leaked review content). */
async function storedText(businessId: string): Promise<string> {
  const rows = await db.select().from(reviewInsights).where(eq(reviewInsights.businessId, businessId));
  return JSON.stringify(rows);
}

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 16, env: ENV });
  db = t.app.get(DB_CLIENT);
  worker = await createTestWorker(t, { mailer, env: ENV });
  owner = await signUpVerified(t, mailer, 'owner@reviews.test', 'Rita Owner');
  org = await createWorkspace(owner, 'Agence Avis');
  admin = (await inviteAndJoin(t, mailer, owner, 'admin@reviews.test', 'admin')).client;
  viewer = (await inviteAndJoin(t, mailer, owner, 'viewer@reviews.test', 'viewer')).client;
  outsider = await signUpVerified(t, mailer, 'outsider@reviews.test', 'Oscar Outsider');
  await createWorkspace(outsider, 'Ailleurs');
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

  it('derives transient insights from Google reviews once the key is set: no text, no reviewer, 30-day expiry', async () => {
    await owner
      .put('/v1/workspace/secrets/google_places', { value: `AIza${'Q'.repeat(31)}Zx9w` })
      .expect(200);
    const id = await track('Le Bistrot Avis');
    const step = await enrichReviews(owner, id);
    expect(step).toMatchObject({ status: 'done' });
    // The fake Google source's paid call is booked.
    expect(step.costUsd).toBeCloseTo(0.025);

    const { body } = await viewer.get(`/v1/businesses/${id}/review-insights`).expect(200);
    expect(body.insights).toMatchObject({
      businessId: id,
      sources: ['google_places'],
      sampleSize: 5,
      ratingSnapshot: { avg: expect.any(Number) },
      ratingTrend: 'unknown',
    });
    expect(body.insights.painCounts.booking_friction).toBeGreaterThan(0);
    // The expiry is 30 days after the fetch (the worker's clock: within a minute of the computation).
    expect(
      Math.abs(Date.parse(body.insights.expiresAt) - Date.parse(body.insights.computedAt) - 30 * DAY_MS),
    ).toBeLessThan(60_000);
    for (const snippets of Object.values(body.insights.evidence) as Array<Array<{ sourceRef: string }>>) {
      for (const snippet of snippets) expect(snippet.sourceRef).toBe('google_places');
    }

    // transient_insights: the review text and the reviewer are nowhere.
    const stored = await storedText(id);
    for (const fragment of ['Impossible to book online', 'answers the phone', 'Alex Fictif', 'Jordan']) {
      expect(stored).not.toContain(fragment);
    }
    expect(await db.select().from(businessReviews).where(eq(businessReviews.businessId, id))).toEqual([]);
    const observations = await db
      .select()
      .from(businessRatingObservations)
      .where(eq(businessRatingObservations.businessId, id));
    expect(observations.map((o) => o.source).sort()).toEqual(['golden_record', 'google_places']);
    expect(observations.every((o) => o.expiresAt !== null)).toBe(true);
  });

  it('forgets what Google gave when the owner withdraws the acknowledgement', async () => {
    const id = await track('Chez Oubli');
    expect((await enrichReviews(owner, id)).status).toBe('done');
    await admin.delete('/v1/reviews/sources/google/acknowledgement').expect(403);
    const status = (await owner.delete('/v1/reviews/sources/google/acknowledgement').expect(200)).body;
    expect(status.googleAcknowledgement).toBeNull();
    expect(await db.select().from(reviewInsights).where(eq(reviewInsights.businessId, id))).toEqual([]);
    expect(await enrichReviews(owner, id)).toMatchObject({
      status: 'skipped',
      skipReason: 'licensing_disabled',
    });
  });

  it('keeps the scraper source off while the scraper itself is not allowed', async () => {
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
  });
});

describe('pasted reviews', () => {
  const PASTE = {
    reviews: [
      {
        text: 'Impossible de réserver en ligne, merci Julie quand même. Écrivez à resa@chez-paste.com',
        rating: 2,
      },
      { text: 'Nobody answers the phone, call +590 590 12 34 56 and good luck.', rating: 1 },
      { text: 'Amazing view, best cocktails in Gustavia, highly recommend!', rating: 5 },
    ],
  };

  it('analyses them on the fly and keeps only aggregates', async () => {
    const id = await track('Chez Paste');
    const { body } = await owner.post(`/v1/businesses/${id}/reviews/analyze`).send(PASTE).expect(200);
    expect(body.insights).toMatchObject({ sources: ['manual'], sampleSize: 3, expiresAt: null });
    expect(body.insights.painCounts).toMatchObject({ booking_friction: 1, unreachable_by_phone: 1 });
    const stored = await storedText(id);
    for (const fragment of [
      'Impossible de réserver',
      'Julie',
      'resa@chez-paste.com',
      '590 12 34',
      'Gustavia',
    ]) {
      expect(stored).not.toContain(fragment);
    }
    expect(await db.select().from(businessReviews).where(eq(businessReviews.businessId, id))).toEqual([]);

    // A second paste merges into the same contribution slot (the latest paste replaces the previous one).
    const again = await owner
      .post(`/v1/businesses/${id}/reviews/analyze`)
      .send({ reviews: [{ text: 'Waited 50 minutes for a table.', rating: 2 }] })
      .expect(200);
    expect(again.body.insights.sampleSize).toBe(1);
  });

  it('validates the paste and enforces roles and workspaces', async () => {
    const id = await track('Chez Droits');
    await owner.post(`/v1/businesses/${id}/reviews/analyze`).send({ reviews: [] }).expect(422);
    await owner
      .post(`/v1/businesses/${id}/reviews/analyze`)
      .send({ reviews: [{ text: 'x'.repeat(2_001) }] })
      .expect(422);
    await viewer.post(`/v1/businesses/${id}/reviews/analyze`).send(PASTE).expect(403);
    await outsider.post(`/v1/businesses/${id}/reviews/analyze`).send(PASTE).expect(404);
    await outsider.get(`/v1/businesses/${id}/review-insights`).expect(404);
    await owner.get('/v1/businesses/00000000-0000-7000-8000-000000000000/review-insights').expect(404);
  });

  it('keeps each workspace’s insights apart', async () => {
    const id = await track('Chez Partage');
    await owner.post(`/v1/businesses/${id}/reviews/analyze`).send(PASTE).expect(200);
    const outsiderOrg = (
      await db.execute<{ id: string }>(sql`SELECT id FROM organizations WHERE name = 'Ailleurs'`)
    )[0]?.id as string;
    await db
      .insert(orgBusinesses)
      .values({ organizationId: outsiderOrg, businessId: id, addedVia: 'search' });
    expect((await outsider.get(`/v1/businesses/${id}/review-insights`).expect(200)).body.insights).toBeNull();
  });
});

describe('retention', () => {
  it('purges expired contributions and rating observations with the nightly maintenance', async () => {
    await owner.post('/v1/reviews/sources/google/acknowledgement').send({ termsVersion: 1 }).expect(200);
    const id = await track('Chez Expire');
    expect((await enrichReviews(owner, id)).status).toBe('done');
    await owner
      .post(`/v1/businesses/${id}/reviews/analyze`)
      .send({ reviews: [{ text: 'Waited an hour, nobody apologised.', rating: 2 }] })
      .expect(200);
    const [row] = await db.select().from(reviewInsights).where(eq(reviewInsights.businessId, id));
    expect(row?.sources.sort()).toEqual(['google_places', 'manual']);

    // Once the Google part has expired, the pasted part stays.
    // The worker fetched on real time (the HTTP app's clock is fixed earlier): well past 30 days from both.
    const later = new Date(Date.now() + 40 * DAY_MS);
    const tasks = worker.get(NightlyMaintenance).all();
    const purge = tasks.get('review_insights_retention');
    expect(purge).toBeDefined();
    expect(await purge?.(later)).toBeGreaterThan(0);
    const [after] = await db.select().from(reviewInsights).where(eq(reviewInsights.businessId, id));
    expect(after?.sources).toEqual(['manual']);
    expect(after?.expiresAt).toBeNull();
    expect(JSON.stringify(after?.evidence)).not.toContain('google_places');
    const left = await db
      .select()
      .from(businessRatingObservations)
      .where(eq(businessRatingObservations.businessId, id));
    expect(left).toEqual([]);
  });
});
