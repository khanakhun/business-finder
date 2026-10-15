import { type EnrichmentStepId, fixedClock, ValidationError } from '@bf/contracts';
import type { DbClient } from '@bf/db';
import {
  businessContacts,
  businesses,
  businessMedia,
  enrichmentEmailVerdicts,
  enrichmentRuns,
  enrichmentSteps,
  orgBusinesses,
  outboxEvents,
  websiteSnapshots,
} from '@bf/db/schema';
import { createLogger } from '@bf/observability';
import { aBusiness, aContact } from '@bf/testing';
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
import { RecordEmailVerificationCommand } from '../business-graph/index.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';
import { ValkeyRateLimiter } from '../platform/rate-limit/valkey-rate-limiter.ts';
import { VALKEY } from '../platform/valkey/valkey.module.ts';
import { WorkspaceDefaults } from '../workspace/index.ts';
import { EmailVerificationService } from './application/email-verification.service.ts';
import { AutoEnrichSubscriber, NightlyRefresh } from './application/enrichment.triggers.ts';
import {
  EMAIL_SUPPRESSION,
  EMAIL_VERDICT_CACHE,
  EMAIL_VERIFIER_LIST,
  type EmailSuppressionCheck,
  type EmailVerdictCache,
  type EmailVerifier,
  ENRICHMENT_REPOSITORY,
  type EnrichmentRepository,
} from './application/ports.ts';
import { fromReacher, fromZeroBounce, MailServerBusyError } from './domain/email-verification.ts';
import { type EnrichmentStep, StepRegistry } from './index.ts';
import { emailHash } from './infrastructure/drizzle-email-verification.ts';
import { PoliteMailServerVerifier } from './infrastructure/email-verifiers.ts';
import { EnrichmentReconciler } from './infrastructure/enrichment-maintenance.ts';

// Enrichment (BF-027) end to end: HTTP app + worker on real Postgres and Valkey, the fake site intel
// (FAKE_SITE_INTEL), and test steps registered through the same registry later tickets use. E-mail verification
// (BF-028) runs the real `email_verify` step with a scripted commercial verifier and a set-based suppression list.

const mailer = new FakeMailer();
const ENV = { FAKE_SITE_INTEL: 'true', FAKE_EMAIL_VERIFIER: 'true' };

/** A commercial verifier (billed per conclusive answer) answering from the local part, recording its calls. */
const VERIFY_COST = 0.008;
const verifierCalls: string[] = [];
const scriptedVerifier: EmailVerifier = {
  id: 'zerobounce',
  available: async () => true,
  verify: async (email) => {
    verifierCalls.push(email);
    const local = email.slice(0, email.lastIndexOf('@'));
    // `busy…`: the mail server is busy the first time it is asked about this address.
    if (local.startsWith('busy') && verifierCalls.filter((e) => e === email).length === 1) {
      throw new MailServerBusyError(1_000);
    }
    const status = local.startsWith('invalid')
      ? 'invalid'
      : local.startsWith('unknown')
        ? 'unknown'
        : 'valid';
    return fromZeroBounce(
      { status, sub_status: '', mx_found: 'true', smtp_provider: 'example' },
      VERIFY_COST,
    );
  },
};
const suppressed = new Set<string>();
const suppression: EmailSuppressionCheck = { isSuppressed: async (_org, email) => suppressed.has(email) };
const OVERRIDES = [
  { token: EMAIL_VERIFIER_LIST, value: [scriptedVerifier] },
  { token: EMAIL_SUPPRESSION, value: suppression },
];
let t: TestApp;
let worker: INestApplicationContext;
let db: DbClient;
let owner: Browser;
let viewer: Browser;
let outsider: Browser;
let org: string;
let outsiderOrg: string;
const DAY_MS = 24 * 3_600_000;

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
      if (mode === 'block' && id === 'reviews') {
        await new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      }
      return { outcome: 'done', costUsd: options.cost ?? 0, outputRef: { test: id }, changedFields: [] };
    },
  };
}

const TEST_STEPS = () => [
  testStep('reviews', { cost: 0.05 }),
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
  t = await createTestApp({ mailer, valkeyDb: 4, env: ENV, overrides: OVERRIDES });
  db = t.app.get(DB_CLIENT);
  worker = await createTestWorker(t, { mailer, env: ENV, overrides: OVERRIDES });
  for (const step of TEST_STEPS()) {
    t.app.get(StepRegistry).register(step);
    worker.get(StepRegistry).register(step);
  }
  owner = await signUpVerified(t, mailer, 'owner@enrich.test', 'Olga Owner');
  org = await createWorkspace(owner, 'Agence Enrich');
  viewer = (await inviteAndJoin(t, mailer, owner, 'viewer@enrich.test', 'viewer')).client;
  outsider = await signUpVerified(t, mailer, 'outsider@enrich.test', 'Oscar Outsider');
  outsiderOrg = await createWorkspace(outsider, 'Ailleurs');
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
      .send({ steps: ['reviews'] })
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
    expect(stepsOf(cancelled)).toEqual({ reviews: ['skipped', 'cancelled'] });
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
      .send({ steps: ['reviews'] })
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
        .send({ businessIds: [a, b], steps: ['reviews'] })
        .expect(200)
    ).body;
    expect(estimate).toMatchObject({
      businesses: 2,
      steps: [{ step: 'reviews', willRun: 2, skipped: 0, costUsd: 0.1 }],
      totalCostUsd: 0.1,
      budget: { monthlyBudgetUsd: 0.06, spentUsd: 0, remainingUsd: 0.06 },
      withinBudget: false,
    });
    const bulk = (
      await budgetOwner
        .post('/v1/enrichment/bulk')
        .send({ businessIds: [a, b], steps: ['reviews'] })
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

describe('e-mail verification (BF-028)', () => {
  const contactsOf = async (client: Browser, id: string) =>
    (await client.get(`/v1/businesses/${id}/contacts`).expect(200)).body.items as Array<
      Record<string, unknown>
    >;
  const emailOf = (items: Array<Record<string, unknown>>, value: string) =>
    items.find((c) => c.normalizedValue === value);

  it('classifies and verifies the business’s addresses, records the verdicts and the cost', async () => {
    const id = await track({ websiteUrl: 'https://www.verify-cafe-enrich.com/' });
    await db.insert(businessContacts).values([
      aContact({
        businessId: id,
        value: 'invalid.box@verify-cafe-enrich.com',
        source: 'manual',
        publishedOnSite: false,
      }),
      aContact({
        businessId: id,
        value: 'cafe.verify@gmail.com',
        source: 'manual',
        publishedOnSite: false,
      }),
    ]);
    await owner
      .post(`/v1/businesses/${id}/enrich`)
      .send({ steps: ['email_verify'] })
      .expect(201);
    const run = await settled(owner, id);
    expect(stepsOf(run)).toEqual({ site_intel: ['done', null], email_verify: ['done', null] });
    const [row] = await db.select().from(enrichmentRuns).where(eq(enrichmentRuns.id, run.id));
    // Three conclusive commercial checks (the crawl found hello@ on the contact page).
    expect(row?.costUsd).toBeCloseTo(3 * VERIFY_COST);
    expect(row?.changedFields).toContain('contacts');

    const items = await contactsOf(owner, id);
    expect(emailOf(items, 'hello@verify-cafe-enrich.com')).toMatchObject({
      subtype: 'generic',
      verificationStatus: 'valid',
      verifiedAt: expect.any(String),
      isFreeMail: false,
      publishedContext: {
        pageUrl: 'https://www.verify-cafe-enrich.com/contact',
        pageKind: 'contact',
        foundAs: 'mailto',
      },
      verificationDetails: { reachable: 'safe', checkedVia: 'zerobounce', provider: 'example' },
    });
    expect(emailOf(items, 'invalid.box@verify-cafe-enrich.com')).toMatchObject({
      verificationStatus: 'invalid',
      publishedContext: null,
    });
    expect(emailOf(items, 'cafe.verify@gmail.com')).toMatchObject({
      verificationStatus: 'valid',
      isFreeMail: true,
      isDisposable: false,
      onWebsiteDomain: false,
    });
    expect(emailOf(items, 'hello@verify-cafe-enrich.com')).toMatchObject({ onWebsiteDomain: true });
    // Verdicts are cached by a hash of the address (never in clear), with the cost they had.
    const [cached] = await db
      .select()
      .from(enrichmentEmailVerdicts)
      .where(eq(enrichmentEmailVerdicts.emailHash, emailHash('invalid.box@verify-cafe-enrich.com')));
    expect(cached).toMatchObject({ status: 'invalid', costUsd: VERIFY_COST, inconclusiveStreak: 0 });
    expect(JSON.stringify(await db.select().from(enrichmentEmailVerdicts))).not.toContain('verify-cafe');
  });

  it('never asks a mail server twice within the TTL: another business’s same address comes from the cache', async () => {
    const first = await track({ websiteUrl: null, websiteHost: null, websiteRegistrableDomain: null });
    const second = await track({ websiteUrl: null, websiteHost: null, websiteRegistrableDomain: null });
    const shared = 'bonjour@shared-verify-enrich.com';
    const contact = aContact({ businessId: second, value: shared });
    await db.insert(businessContacts).values([aContact({ businessId: first, value: shared }), contact]);
    // No website: the crawl is skipped, the known address is verified all the same (optional dependency).
    await owner
      .post(`/v1/businesses/${first}/enrich`)
      .send({ steps: ['email_verify'] })
      .expect(201);
    expect(stepsOf(await settled(owner, first))).toEqual({
      site_intel: ['skipped', 'no_website'],
      email_verify: ['done', null],
    });
    expect(verifierCalls.filter((e) => e === shared)).toHaveLength(1);

    const started = await owner.post(`/v1/contacts/${contact.id}/verify`).expect(201);
    expect(started.body.requestedSteps).toEqual(['email_verify']);
    const run = await settled(owner, second);
    expect(verifierCalls.filter((e) => e === shared)).toHaveLength(1);
    const [row] = await db.select().from(enrichmentRuns).where(eq(enrichmentRuns.id, run.id));
    expect(row?.costUsd).toBe(0);
    expect(emailOf(await contactsOf(owner, second), shared)).toMatchObject({ verificationStatus: 'valid' });
  });

  it('checks the suppression list before any verifier', async () => {
    const id = await track({ websiteUrl: null, websiteHost: null, websiteRegistrableDomain: null });
    const address = 'stop@suppressed-verify-enrich.com';
    suppressed.add(address);
    await db.insert(businessContacts).values(aContact({ businessId: id, value: address }));
    await owner
      .post(`/v1/businesses/${id}/enrich`)
      .send({ steps: ['email_verify'] })
      .expect(201);
    const run = await settled(owner, id);
    const [step] = await db
      .select()
      .from(enrichmentSteps)
      .where(and(eq(enrichmentSteps.runId, run.id), eq(enrichmentSteps.step, 'email_verify')));
    expect(step).toMatchObject({
      status: 'done',
      outputRef: expect.objectContaining({ suppressed: 1, checked: 0 }),
    });
    expect(verifierCalls).not.toContain(address);
    expect(emailOf(await contactsOf(owner, id), address)).toMatchObject({ verificationStatus: 'unknown' });
    expect(
      await db
        .select()
        .from(enrichmentEmailVerdicts)
        .where(eq(enrichmentEmailVerdicts.emailHash, emailHash(address))),
    ).toEqual([]);
  });

  it('is polite per mail server under a burst, with a share per workspace (real Valkey, fake clock)', async () => {
    const clock = fixedClock('2026-10-15T12:00:00.000Z');
    const calls: string[] = [];
    const counting: EmailVerifier = {
      id: 'reacher',
      available: async () => true,
      verify: async (email) => {
        calls.push(email);
        return fromReacher({ is_reachable: 'safe' });
      },
    };
    // Two domains on one mail server, a third on another (documentation addresses allowed here).
    const dns = {
      resolveMx: async (domain: string) => [
        {
          exchange: domain.startsWith('other') ? 'mx.other-host.example' : 'mx.shared-host.example',
          priority: 10,
        },
      ],
      resolve4: async () => ['198.51.100.25'],
      resolve6: async () => [],
    };
    const limiter = new ValkeyRateLimiter(t.app.get<Redis>(VALKEY), clock, true);
    const service = (perMinute: number) =>
      new EmailVerificationService(
        [new PoliteMailServerVerifier(counting, { dns, limiter, perMinute, isPublic: () => true })],
        t.app.get<EmailVerdictCache>(EMAIL_VERDICT_CACHE),
        { isSuppressed: async () => false },
        t.app.get(WorkspaceDefaults),
        clock,
        t.env,
        createLogger({ service: 'test', level: 'fatal' }),
      );
    const polite = service(12);
    const verify = (email: string, organizationId = org) =>
      polite.verify(organizationId, email, new AbortController().signal);
    const burst = await Promise.all(
      ['a@one-burst.example', 'b@two-burst.example', 'c@one-burst.example'].map(async (email) => ({
        email,
        ...(await verify(email)),
      })),
    );
    // One workspace gets one check per mail server at once (its half-rate share, capacity 1).
    expect(burst.filter((o) => o.kind === 'verdict')).toHaveLength(1);
    const limited = burst.filter((o) => o.kind === 'rate_limited');
    expect(limited).toHaveLength(2);
    for (const outcome of limited) {
      expect(outcome.kind === 'rate_limited' && outcome.retryAfterMs).toBeGreaterThan(0);
      expect(outcome.kind === 'rate_limited' && outcome.retryAfterMs).toBeLessThanOrEqual(10_000);
    }
    // Another mail server has its own buckets.
    expect((await verify('d@other-burst.example')).kind).toBe('verdict');
    // Another workspace still gets the server's remaining token.
    expect((await verify('e@one-burst.example', outsiderOrg)).kind).toBe('verdict');
    // The workspace's share comes back after 10 s (6 per minute for it, 12 for everyone).
    clock.advance(10_000);
    const [next] = limited.map((o) => o.email);
    expect((await verify(next ?? '')).kind).toBe('verdict');
    // A cached verdict needs no token.
    const [first] = burst.filter((o) => o.kind === 'verdict').map((o) => o.email);
    expect((await verify(first ?? '')).kind).toBe('verdict');
    expect(calls).toHaveLength(4);
  });

  it('a step waiting for a busy mail server resumes and books each paid check once', async () => {
    const id = await track({ websiteUrl: null, websiteHost: null, websiteRegistrableDomain: null });
    await db
      .insert(businessContacts)
      .values([
        aContact({ businessId: id, value: 'paid@resume-verify-enrich.com' }),
        aContact({ businessId: id, value: 'busy@resume-verify-enrich.com' }),
      ]);
    await owner
      .post(`/v1/businesses/${id}/enrich`)
      .send({ steps: ['email_verify'] })
      .expect(201);
    const run = await settled(owner, id);
    expect(stepsOf(run)).toMatchObject({ email_verify: ['done', null] });
    const [step] = await db
      .select()
      .from(enrichmentSteps)
      .where(and(eq(enrichmentSteps.runId, run.id), eq(enrichmentSteps.step, 'email_verify')));
    // Deferred once (no attempt used); the first pass's paid check came back from the cache the second time.
    expect(step).toMatchObject({ deferrals: 1, attempt: 1 });
    expect(step?.costUsd).toBeCloseTo(2 * VERIFY_COST);
    const [row] = await db.select().from(enrichmentRuns).where(eq(enrichmentRuns.id, run.id));
    expect(row?.costUsd).toBeCloseTo(2 * VERIFY_COST);
    expect(row?.changedFields).toEqual(['contacts']);
  });

  it('never downgrades a verdict to "unknown", nor replaces it with an older one', async () => {
    const id = await track({ websiteUrl: null, websiteHost: null, websiteRegistrableDomain: null });
    const address = 'kept@downgrade-verify-enrich.com';
    await db.insert(businessContacts).values(aContact({ businessId: id, value: address }));
    const record = t.app.get(RecordEmailVerificationCommand);
    const valid = fromReacher({ is_reachable: 'safe' });
    const at = new Date('2026-10-15T10:00:00.000Z');
    expect(
      await record.execute(id, address, { status: 'valid', details: valid.details, verifiedAt: at }),
    ).toBe(true);
    const unknown = fromReacher({ is_reachable: 'unknown' });
    const later = new Date('2026-10-16T10:00:00.000Z');
    expect(
      await record.execute(id, address, { status: 'unknown', details: unknown.details, verifiedAt: later }),
    ).toBe(false);
    const older = new Date('2026-10-01T10:00:00.000Z');
    const invalid = fromReacher({ is_reachable: 'invalid' });
    expect(
      await record.execute(id, address, { status: 'invalid', details: invalid.details, verifiedAt: older }),
    ).toBe(false);
    const [row] = await db.select().from(businessContacts).where(eq(businessContacts.businessId, id));
    expect(row).toMatchObject({ verificationStatus: 'valid', verifiedAt: at });
  });

  it('the nightly refresh picks up inconclusive checks when due, and purges expired verdicts', async () => {
    const id = await track({ websiteUrl: null, websiteHost: null, websiteRegistrableDomain: null });
    await db
      .insert(businessContacts)
      .values(aContact({ businessId: id, value: 'unknown@recheck-verify-enrich.com' }));
    await owner
      .post(`/v1/businesses/${id}/enrich`)
      .send({ steps: ['email_verify'] })
      .expect(201);
    const run = await settled(owner, id);
    const [step] = await db
      .select()
      .from(enrichmentSteps)
      .where(and(eq(enrichmentSteps.runId, run.id), eq(enrichmentSteps.step, 'email_verify')));
    const recheckAt = Date.parse(String(step?.outputRef?.recheckAt));
    expect(recheckAt).toBeGreaterThan(Date.now());
    const repo = t.app.get<EnrichmentRepository>(ENRICHMENT_REPOSITORY);
    const candidates = (at: number) =>
      repo.refreshCandidates(
        org,
        [{ step: 'email_verify', staleBefore: new Date(at - 60 * DAY_MS) }],
        10_000,
        new Date(at),
      );
    expect(await candidates(Date.now())).not.toContain(id);
    expect(await candidates(recheckAt + 1_000)).toContain(id);

    const cache = t.app.get<EmailVerdictCache>(EMAIL_VERDICT_CACHE);
    expect(await cache.get('unknown@recheck-verify-enrich.com')).toBeDefined();
    expect(await cache.purgeExpired(new Date(recheckAt + 1_000))).toBeGreaterThan(0);
    expect(await cache.get('unknown@recheck-verify-enrich.com')).toBeUndefined();
  });

  it('guards the on-demand check and the SMTP diagnostic', async () => {
    const id = await track({ websiteUrl: null, websiteHost: null, websiteRegistrableDomain: null });
    const email = aContact({ businessId: id, value: 'authz@verify-authz-enrich.com' });
    const phone = aContact({ businessId: id, type: 'phone' });
    await db.insert(businessContacts).values([email, phone]);
    await viewer.post(`/v1/contacts/${email.id}/verify`).expect(403);
    await outsider.post(`/v1/contacts/${email.id}/verify`).expect(404);
    await owner.post('/v1/contacts/019a0000-0000-7000-8000-00000000dead/verify').expect(404);
    await owner.post(`/v1/contacts/${phone.id}/verify`).expect(422);
    await owner.post(`/v1/contacts/${email.id}/verify`).expect(201);
    await settled(owner, id);
    // On demand, the address is checked without crawling the site first.
    const withSite = await track({ websiteUrl: 'https://www.verify-nocrawl-enrich.com/' });
    const onSite = aContact({ businessId: withSite, value: 'hello@verify-nocrawl-enrich.com' });
    await db.insert(businessContacts).values(onSite);
    const verifying = await owner.post(`/v1/contacts/${onSite.id}/verify`).expect(201);
    expect(stepsOf(verifying.body)).toEqual({ email_verify: ['queued', null] });
    expect(stepsOf(await settled(owner, withSite))).toEqual({ email_verify: ['done', null] });

    await viewer.post('/v1/workspace/diagnostics/smtp-port').expect(403);
    const diagnostic = (await owner.post('/v1/workspace/diagnostics/smtp-port').expect(200)).body;
    expect(diagnostic).toEqual({
      reachable: true,
      host: 'mx.example.test',
      latencyMs: 12,
      error: null,
      reacherConfigured: false,
    });
  });
});
