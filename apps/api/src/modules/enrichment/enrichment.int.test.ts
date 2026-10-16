import { type EnrichmentStepId, ValidationError } from '@bf/contracts';
import type { DbClient } from '@bf/db';
import {
  businessContacts,
  businesses,
  businessMedia,
  enrichmentRuns,
  enrichmentSteps,
  orgBusinesses,
  outboxEvents,
  websiteSnapshots,
} from '@bf/db/schema';
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
import { AutoEnrichSubscriber, NightlyRefresh } from './application/enrichment.triggers.ts';
import { type EnrichmentStep, StepRegistry } from './index.ts';
import { EnrichmentReconciler } from './infrastructure/enrichment-maintenance.ts';

// Enrichment (BF-027) end to end: HTTP app + worker on real Postgres and Valkey, the fake site intel
// (FAKE_SITE_INTEL), and test steps registered through the same registry later tickets use.

const mailer = new FakeMailer();
const ENV = { FAKE_SITE_INTEL: 'true' };
let t: TestApp;
let worker: INestApplicationContext;
let db: DbClient;
let owner: Browser;
let viewer: Browser;
let outsider: Browser;
let org: string;

/** What the test steps do, per business. */
const behaviour = new Map<string, 'fail' | 'block'>();
const executed: Array<{ step: EnrichmentStepId; businessId: string }> = [];

function testStep(
  id: EnrichmentStepId,
  options: { dependsOn?: EnrichmentStepId[]; cost?: number } = {},
): EnrichmentStep {
  return {
    id,
    dependsOn: options.dependsOn ?? [],
    costCategory: options.cost ? 'provider' : 'free',
    ttlDays: 30,
    appliesTo: () => true,
    inputHash: (subject) => `${id}:${subject.websiteUrl ?? ''}`,
    estimateCost: () => options.cost ?? 0,
    execute: async ({ subject, signal }) => {
      executed.push({ step: id, businessId: subject.businessId });
      const mode = behaviour.get(subject.businessId);
      if (mode === 'fail' && id === 'reviews')
        throw new ValidationError('The reviews provider refused the place.');
      if (mode === 'block' && (id === 'email_verify' || id === 'reviews')) {
        await new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      }
      return { outcome: 'done', costUsd: options.cost ?? 0, outputRef: { test: id }, changedFields: [] };
    },
  };
}

const TEST_STEPS = () => [
  testStep('email_verify', { cost: 0.05 }),
  testStep('reviews'),
  testStep('psi', { dependsOn: ['site_intel'] }),
  testStep('vision_audit', { dependsOn: ['site_intel', 'reviews'] }),
];

async function track(overrides: Parameters<typeof aBusiness>[0] = {}, organizationId = org): Promise<string> {
  const business = aBusiness(overrides);
  await db.insert(businesses).values(business);
  await db.insert(orgBusinesses).values({ organizationId, businessId: business.id, addedVia: 'search' });
  return business.id;
}

async function settled(
  client: Browser,
  businessId: string,
): Promise<{ id: string; status: string; steps: Array<Record<string, unknown>> }> {
  await expect
    .poll(
      async () => {
        const run = (await client.get(`/v1/businesses/${businessId}/enrichment`).expect(200)).body.latestRun;
        return run?.status;
      },
      { timeout: 30_000, interval: 100 },
    )
    .toMatch(/^(completed|partially_completed|failed|cancelled)$/);
  return (await client.get(`/v1/businesses/${businessId}/enrichment`).expect(200)).body.latestRun;
}

const stepsOf = (run: { steps: Array<Record<string, unknown>> }) =>
  Object.fromEntries(run.steps.map((s) => [s.step, [s.status, s.skipReason]]));

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 4, env: ENV });
  db = t.app.get(DB_CLIENT);
  worker = await createTestWorker(t, { mailer, env: ENV });
  for (const step of TEST_STEPS()) {
    t.app.get(StepRegistry).register(step);
    worker.get(StepRegistry).register(step);
  }
  owner = await signUpVerified(t, mailer, 'owner@enrich.test', 'Olga Owner');
  org = await createWorkspace(owner, 'Agence Enrich');
  viewer = (await inviteAndJoin(t, mailer, owner, 'viewer@enrich.test', 'viewer')).client;
  outsider = await signUpVerified(t, mailer, 'outsider@enrich.test', 'Oscar Outsider');
  await createWorkspace(outsider, 'Ailleurs');
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await t?.close();
});

describe('manual enrichment', () => {
  it('runs the DAG, stores the snapshot and ingests website facts with provenance', async () => {
    const id = await track({ websiteUrl: 'https://www.salon-ondine-enrich.com/' });
    const started = await owner.post(`/v1/businesses/${id}/enrich`).send({}).expect(201);
    expect(started.body.trigger).toBe('manual');
    const run = await settled(owner, id);
    expect(run.status).toBe('completed');
    expect(stepsOf(run)).toEqual({
      site_intel: ['done', null],
      email_verify: ['done', null],
      reviews: ['done', null],
      psi: ['done', null],
      vision_audit: ['done', null],
    });
    // Dependencies ran first.
    const order = executed.filter((e) => e.businessId === id).map((e) => e.step);
    expect(order.indexOf('vision_audit')).toBeGreaterThan(order.indexOf('reviews'));

    const website = (await owner.get(`/v1/businesses/${id}/website`).expect(200)).body;
    expect(website.reachability).toBe('ok');
    expect(website.contacts.emails[0].email).toBe('hello@salon-ondine-enrich.com');
    expect(website.booking.providers[0].name).toBe('Planity');
    expect(website.pages[0]).not.toHaveProperty('markdownKey');

    const [email] = await db
      .select()
      .from(businessContacts)
      .where(and(eq(businessContacts.businessId, id), eq(businessContacts.type, 'email')));
    expect(email).toMatchObject({
      source: 'website',
      publishedOnSite: true,
      sourceUrl: 'https://www.salon-ondine-enrich.com/contact',
    });
    const media = await db.select().from(businessMedia).where(eq(businessMedia.businessId, id));
    expect(media.map((m) => [m.kind, m.license, m.externalUrl])).toEqual([
      ['logo', 'owner_site', 'https://www.salon-ondine-enrich.com/logo.png'],
    ]);
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.type, 'business.enriched'));
    expect(events.some((e) => (e.payload as { businessId: string }).businessId === id)).toBe(true);
  });

  it('skips fresh steps unless forced, and joins a request to the same key', async () => {
    const id = await track({ websiteUrl: 'https://www.cafe-corail-enrich.com/' });
    await owner
      .post(`/v1/businesses/${id}/enrich`)
      .send({ steps: ['site_intel'] })
      .expect(201);
    await settled(owner, id);
    const again = await owner
      .post(`/v1/businesses/${id}/enrich`)
      .set('Idempotency-Key', 'again-key-001')
      .send({ steps: ['site_intel'] })
      .expect(201);
    expect(stepsOf(again.body)).toEqual({ site_intel: ['skipped', 'fresh'] });
    const same = await owner
      .post(`/v1/businesses/${id}/enrich`)
      .set('Idempotency-Key', 'again-key-001')
      .send({ steps: ['site_intel'] })
      .expect(200);
    expect(same.body.id).toBe(again.body.id);
    await settled(owner, id);
    const forced = await owner
      .post(`/v1/businesses/${id}/enrich`)
      .send({ steps: ['site_intel'], force: true });
    expect(stepsOf(forced.body)).toEqual({ site_intel: ['queued', null] });
    expect((await settled(owner, id)).status).toBe('completed');
    expect(await db.select().from(websiteSnapshots).where(eq(websiteSnapshots.businessId, id))).toHaveLength(
      2,
    );
  });

  it('isolates a failed step: independent steps finish, dependents are skipped', async () => {
    const id = await track({ websiteUrl: 'https://www.villa-azur-enrich.com/' });
    behaviour.set(id, 'fail');
    await owner.post(`/v1/businesses/${id}/enrich`).send({}).expect(201);
    const run = await settled(owner, id);
    expect(run.status).toBe('partially_completed');
    expect(stepsOf(run)).toMatchObject({
      site_intel: ['done', null],
      reviews: ['failed', null],
      psi: ['done', null],
      vision_audit: ['skipped', 'dependency_failed'],
    });
    expect(run.steps.find((s) => s.step === 'reviews')?.error).toBe(
      'The reviews provider refused the place.',
    );
  });

  it('skips website steps for a business without a website', async () => {
    const id = await track({ websiteUrl: null, websiteHost: null, websiteRegistrableDomain: null });
    await owner
      .post(`/v1/businesses/${id}/enrich`)
      .send({ steps: ['psi'] })
      .expect(201);
    const run = await settled(owner, id);
    expect(stepsOf(run)).toEqual({
      site_intel: ['skipped', 'no_website'],
      psi: ['skipped', 'dependency_skipped'],
    });
    await owner.get(`/v1/businesses/${id}/website`).expect(404);
  });

  it('cancels a running run', async () => {
    const id = await track({ websiteUrl: 'https://www.spa-lumiere-enrich.com/' });
    behaviour.set(id, 'block');
    const { body } = await owner
      .post(`/v1/businesses/${id}/enrich`)
      .send({ steps: ['email_verify'] })
      .expect(201);
    await expect
      .poll(
        async () => {
          const run = (await owner.get(`/v1/enrichment/runs/${body.id}`).expect(200)).body;
          return run.steps[0].status;
        },
        { timeout: 20_000, interval: 100 },
      )
      .toBe('running');
    const cancelled = (await owner.post(`/v1/enrichment/runs/${body.id}/cancel`).expect(200)).body;
    expect(cancelled.status).toBe('cancelled');
    expect(stepsOf(cancelled)).toEqual({ email_verify: ['skipped', 'cancelled'] });
  });

  it('enforces roles and workspaces', async () => {
    const id = await track({ websiteUrl: 'https://www.authz-enrich.com/' });
    behaviour.set(id, 'block');
    await viewer.post(`/v1/businesses/${id}/enrich`).send({}).expect(403);
    await viewer.get(`/v1/businesses/${id}/enrichment`).expect(200);
    await viewer
      .post('/v1/enrichment/bulk')
      .send({ businessIds: [id] })
      .expect(403);
    await outsider.post(`/v1/businesses/${id}/enrich`).send({}).expect(404);
    await outsider.get(`/v1/businesses/${id}/enrichment`).expect(404);
    await outsider.get(`/v1/businesses/${id}/website`).expect(404);
    await outsider.get(`/v1/businesses/${id}/website/screenshots/desktop`).expect(404);
    const { body } = await owner
      .post(`/v1/businesses/${id}/enrich`)
      .send({ steps: ['email_verify'] })
      .expect(201);
    await outsider.get(`/v1/enrichment/runs/${body.id}`).expect(404);
    await outsider.post(`/v1/enrichment/runs/${body.id}/cancel`).expect(404);
    await viewer.post(`/v1/enrichment/runs/${body.id}/cancel`).expect(403);
    expect((await owner.get(`/v1/enrichment/runs/${body.id}`).expect(200)).body.status).not.toBe('cancelled');
    // An Idempotency-Key used for one business is not another business's run.
    const other = await track({ websiteUrl: 'https://www.authz-other-enrich.com/' });
    await owner
      .post(`/v1/businesses/${other}/enrich`)
      .set('Idempotency-Key', 'authz-key-0001')
      .send({ steps: ['site_intel'] })
      .expect(201);
    await owner
      .post(`/v1/businesses/${id}/enrich`)
      .set('Idempotency-Key', 'authz-key-0001')
      .send({ steps: ['site_intel'] })
      .expect(409);
    await owner.post(`/v1/enrichment/runs/${body.id}/cancel`).expect(200);
  });

  it('never lets a website fact override a manual value', async () => {
    const created = await owner
      .post('/v1/businesses')
      .send({
        displayName: 'Chez Manuel',
        countryCode: 'BL',
        websiteUrl: 'https://named.chez-manuel-enrich.com/',
      })
      .expect(201);
    const id = created.body.id as string;
    await owner
      .post(`/v1/businesses/${id}/enrich`)
      .send({ steps: ['site_intel'] })
      .expect(201);
    expect((await settled(owner, id)).status).toBe('completed');
    // The site calls itself "Named On The Site"; the name entered by hand stays.
    const detail = (await owner.get(`/v1/businesses/${id}`).expect(200)).body;
    expect(detail.displayName).toBe('Chez Manuel');
    expect((await owner.get(`/v1/businesses/${id}/website`).expect(200)).body.contacts.emails[0].email).toBe(
      'hello@named.chez-manuel-enrich.com',
    );
  });

  it('keeps a no-solicitation statement after crawls that no longer see it', async () => {
    const id = await track({ websiteUrl: 'https://nosolicit.salon-quiet-enrich.com/' });
    await owner
      .post(`/v1/businesses/${id}/enrich`)
      .send({ steps: ['site_intel'] })
      .expect(201);
    await settled(owner, id);
    const seen = (await owner.get(`/v1/businesses/${id}/website`).expect(200)).body;
    expect(seen.noSolicitationMarker).toMatchObject({ phrases: ['no solicitation'] });
    // The site goes down, then comes back without the statement: the marker stays.
    for (const site of ['https://down.salon-quiet-enrich.com/', 'https://www.salon-quiet-enrich.com/']) {
      await db.update(businesses).set({ websiteUrl: site }).where(eq(businesses.id, id));
      await owner
        .post(`/v1/businesses/${id}/enrich`)
        .send({ steps: ['site_intel'], force: true })
        .expect(201);
      await settled(owner, id);
      const later = (await owner.get(`/v1/businesses/${id}/website`).expect(200)).body;
      expect(later.noSolicitation.detected).toBe(false);
      expect(later.noSolicitationMarker).toMatchObject({ phrases: ['no solicitation'] });
    }
    const [event] = (
      await db.select().from(outboxEvents).where(eq(outboxEvents.type, 'business.enriched'))
    ).filter((e) => (e.payload as { businessId: string }).businessId === id);
    expect(event?.payload).toMatchObject({ noSolicitationDetected: true });
  });
});

describe('bulk, budget and triggers', () => {
  it('estimates and keeps within the monthly budget, exactly', async () => {
    // A workspace of its own: its spend this month is only what this test does.
    const budgetOwner = await signUpVerified(t, mailer, 'budget@enrich.test', 'Bea Budget');
    const budgetOrg = await createWorkspace(budgetOwner, 'Agence Budget');
    const a = await track({ websiteUrl: 'https://www.boulangerie-a-enrich.com/' }, budgetOrg);
    const b = await track({ websiteUrl: 'https://www.boulangerie-b-enrich.com/' }, budgetOrg);
    await budgetOwner
      .patch('/v1/workspace/settings')
      .send({ enrichment: { monthlyBudgetUsd: 0.06 } })
      .expect(200);
    const estimate = (
      await budgetOwner
        .post('/v1/enrichment/estimate')
        .send({ businessIds: [a, b], steps: ['email_verify'] })
        .expect(200)
    ).body;
    expect(estimate).toMatchObject({
      businesses: 2,
      steps: [{ step: 'email_verify', willRun: 2, skipped: 0, costUsd: 0.1 }],
      totalCostUsd: 0.1,
      budget: { monthlyBudgetUsd: 0.06, spentUsd: 0, remainingUsd: 0.06 },
      withinBudget: false,
    });
    const bulk = (
      await budgetOwner
        .post('/v1/enrichment/bulk')
        .send({ businessIds: [a, b], steps: ['email_verify'] })
        .expect(202)
    ).body;
    // $0.05 fits in $0.06; the second $0.05 does not.
    expect(bulk.runs).toEqual([{ businessId: a, runId: expect.any(String) }]);
    expect(bulk.rejected).toEqual([{ businessId: b, reason: 'budget' }]);
    // Free steps still run on what is left.
    const free = await budgetOwner
      .post(`/v1/businesses/${b}/enrich`)
      .send({ steps: ['site_intel'] })
      .expect(201);
    expect(free.body.steps.map((s: { status: string }) => s.status)).toEqual(['queued']);
    // Another workspace's estimate never sees these businesses.
    const foreign = (
      await owner
        .post('/v1/enrichment/estimate')
        .send({ businessIds: [a, b] })
        .expect(200)
    ).body;
    expect(foreign.businesses).toBe(0);
  });

  it('enriches what a discovery run found when it asked to', async () => {
    const id = await track({ websiteUrl: 'https://www.epicerie-enrich.com/' });
    await worker.get(AutoEnrichSubscriber).onFound({
      id: '019a0000-0000-7000-8000-000000000001',
      type: 'discovery.business.found',
      version: 1,
      occurredAt: '2026-10-14T12:00:00.000Z',
      orgId: org,
      actor: { type: 'job', id: 'discovery' },
      correlationId: null,
      causationId: null,
      payload: { runId: '019a0000-0000-7000-8000-0000000000aa', businessId: id },
    } as never);
    const run = await settled(owner, id);
    const [row] = await db.select().from(enrichmentRuns).where(eq(enrichmentRuns.id, run.id));
    expect(row?.trigger).toBe('discovery');
  });

  it('refreshes stale businesses nightly, up to the workspace cap', async () => {
    await owner
      .patch('/v1/workspace/settings')
      .send({ enrichment: { nightlyRefreshLimit: 1 } })
      .expect(200);
    await track({ websiteUrl: 'https://www.never-enriched-1.com/' });
    await track({ websiteUrl: 'https://www.never-enriched-2.com/' });
    const scheduled = async () =>
      (
        await db
          .select()
          .from(enrichmentRuns)
          .where(and(eq(enrichmentRuns.triggeredByOrgId, org), eq(enrichmentRuns.trigger, 'schedule')))
      ).length;
    await worker.get(NightlyRefresh).run('2026-10-15');
    expect(await scheduled()).toBe(1);
    // The same day again (a retried job): the cap counts what it already started.
    await worker.get(NightlyRefresh).run('2026-10-15');
    expect(await scheduled()).toBe(1);
    await owner
      .patch('/v1/workspace/settings')
      .send({ enrichment: { nightlyRefreshLimit: 100 } })
      .expect(200);
  });
});

describe('recovery', () => {
  it('never runs a step before its dependency, even when the reconciler re-enqueues it', async () => {
    const id = await track({ websiteUrl: 'https://www.slow-dependency-enrich.com/' });
    behaviour.set(id, 'block');
    // vision_audit needs reviews; reviews (blocked here) is still running.
    const { body } = await owner
      .post(`/v1/businesses/${id}/enrich`)
      .send({ steps: ['vision_audit'] })
      .expect(201);
    const step = async (name: string) =>
      (await owner.get(`/v1/enrichment/runs/${body.id}`).expect(200)).body.steps.find(
        (s: { step: string }) => s.step === name,
      );
    await expect
      .poll(async () => (await step('reviews'))?.status, { timeout: 20_000, interval: 100 })
      .toBe('running');
    // Make the waiting step look like its job was lost long ago.
    await db
      .update(enrichmentSteps)
      .set({ updatedAt: new Date(Date.now() - 10 * 60_000) })
      .where(and(eq(enrichmentSteps.runId, body.id), eq(enrichmentSteps.step, 'vision_audit')));
    const summary = await worker.get(EnrichmentReconciler).reconcile();
    expect(summary.reenqueued).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await step('vision_audit'))?.status).toBe('queued');
    expect(executed.filter((e) => e.businessId === id && e.step === 'vision_audit')).toEqual([]);
    await owner.post(`/v1/enrichment/runs/${body.id}/cancel`).expect(200);
  });

  it('requeues a step whose worker died and finishes the run', async () => {
    const id = await track({ websiteUrl: 'https://www.lost-worker-enrich.com/' });
    const { body } = await owner
      .post(`/v1/businesses/${id}/enrich`)
      .send({ steps: ['reviews'] })
      .expect(201);
    await settled(owner, id);
    // Simulate a crash mid-step: back to running with an old heartbeat, run reopened.
    await db
      .update(enrichmentSteps)
      .set({
        status: 'running',
        heartbeatAt: new Date(Date.now() - 10 * 60_000),
        attempt: 1,
        finishedAt: null,
      })
      .where(eq(enrichmentSteps.runId, body.id));
    await db
      .update(enrichmentRuns)
      .set({ status: 'running', finishedAt: null })
      .where(eq(enrichmentRuns.id, body.id));
    const summary = await worker.get(EnrichmentReconciler).reconcile();
    expect(summary.requeued).toBe(1);
    const run = await settled(owner, id);
    expect(run.status).toBe('completed');
    expect(run.steps[0]?.attempt).toBe(2);
  });
});
