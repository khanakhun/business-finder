import { fixedClock } from '@bf/contracts';
import type { DbClient } from '@bf/db';
import { businessCategories, businesses, categories, orgBusinesses, websiteAudits } from '@bf/db/schema';
import { aBusiness } from '@bf/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestWorker, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import { type Browser, createWorkspace, signUpVerified } from '../../../test/identity-helpers.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';
import {
  WEBSITE_AUDITS,
  WEBSITE_SNAPSHOTS,
  type WebsiteAuditRepository,
  type WebsiteSnapshotRepository,
} from './application/ports.ts';
import { WebsiteAuditService } from './application/website-audit.service.ts';
import { FakePageSpeed } from './infrastructure/pagespeed.ts';
import { FakeVisionGrader } from './infrastructure/vision-graders.ts';

// Website audit (BF-030) end to end: HTTP app + worker on real Postgres and Valkey, the real `psi` and `vision_audit`
// steps over the fake crawl, PageSpeed and vision grader (FAKE_SITE_INTEL, FAKE_WEBSITE_AUDIT: a host containing
// `slow` gets poor PageSpeed results, `ugly` a poor visual grade, `down.` an unreachable site).

const mailer = new FakeMailer();
const ENV = { FAKE_SITE_INTEL: 'true', FAKE_EMAIL_VERIFIER: 'true', FAKE_WEBSITE_AUDIT: 'true' };
// A fixed instant (findings depend on the year); app and worker share it.
const clock = fixedClock('2026-10-14T12:00:00.000Z');
let t: TestApp;
let worker: INestApplicationContext;
let db: DbClient;
let owner: Browser;
let outsider: Browser;
let org: string;

async function track(websiteUrl: string | null): Promise<string> {
  const host = websiteUrl ? new URL(websiteUrl).hostname : null;
  const business = aBusiness({ websiteUrl, websiteHost: host, websiteRegistrableDomain: host });
  await db.insert(businesses).values(business);
  await db.insert(orgBusinesses).values({ organizationId: org, businessId: business.id, addedVia: 'search' });
  return business.id;
}

async function audit(businessId: string, steps = ['vision_audit']) {
  await owner.post(`/v1/businesses/${businessId}/enrich`).send({ steps, force: true }).expect(201);
  await expect
    .poll(
      async () =>
        (await owner.get(`/v1/businesses/${businessId}/enrichment`).expect(200)).body.latestRun?.status,
      { timeout: 30_000, interval: 100 },
    )
    .toMatch(/^(completed|partially_completed|failed|cancelled)$/);
  const run = (await owner.get(`/v1/businesses/${businessId}/enrichment`).expect(200)).body.latestRun;
  return Object.fromEntries(run.steps.map((s: { step: string; status: string }) => [s.step, s.status]));
}

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 17, env: ENV, clock });
  db = t.app.get(DB_CLIENT);
  worker = await createTestWorker(t, { mailer, env: ENV, clock });
  owner = await signUpVerified(t, mailer, 'owner@audit.test', 'Ada Owner');
  org = await createWorkspace(owner, 'Agence Audit');
  outsider = await signUpVerified(t, mailer, 'outsider@audit.test', 'Oscar Outsider');
  await createWorkspace(outsider, 'Ailleurs');
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await t?.close();
});

describe('website audit', () => {
  it('runs crawl → PageSpeed → vision and stores a complete audit', async () => {
    const id = await track('https://www.bistro-audit-good.com/');
    // Asking for the vision audit brings its dependencies (crawl, then PageSpeed).
    expect(await audit(id)).toEqual({ site_intel: 'done', psi: 'done', vision_audit: 'done' });
    const { body } = await owner.get(`/v1/businesses/${id}/website-audit`).expect(200);
    expect(body.audit).toMatchObject({
      businessId: id,
      psi: { mobile: { scores: { performance: 86 } }, desktop: { scores: { performance: 95 } } },
      vision: { overall: 8, model: 'fake-vision-grader' },
      websiteStatus: 'strong',
    });
    expect(body.status).toBe('strong');
    expect(body.audit.qualityScore).toBeGreaterThanOrEqual(80);
    // The fake crawl: copyright 2021, no contact form, no phone (an e-mail is there).
    expect(body.audit.findings.map((f: { code: string }) => f.code)).toEqual(
      expect.arrayContaining(['stale_copyright', 'no_contact_form']),
    );
    expect(body.audit.findings.map((f: { code: string }) => f.code)).not.toContain('no_contact_visible');
  });

  it('rates a slow, dated site weak, and the listing filter finds it', async () => {
    const weak = await track('https://www.slow-ugly-cafe.com/');
    const good = await track('https://www.fine-audit-cafe.com/');
    await audit(weak);
    await audit(good);
    const { body } = await owner.get(`/v1/businesses/${weak}/website-audit`).expect(200);
    expect(body.audit.websiteStatus).toBe('weak');
    expect(body.audit.qualityScore).toBeLessThan(60);
    expect(body.audit.findings.map((f: { code: string }) => f.code)).toEqual(
      expect.arrayContaining([
        'slow_lcp_mobile',
        'low_performance_score',
        'dated_design',
        'weak_call_to_action',
      ]),
    );
    const listing = (await owner.get('/v1/businesses').query({ website: 'weak', limit: 100 }).expect(200))
      .body;
    const ids = listing.items.map((item: { id: string }) => item.id);
    expect(ids).toContain(weak);
    expect(ids).not.toContain(good);
  });

  it('marks an unreachable site broken without measuring it', async () => {
    const id = await track('https://down.audit-broken.com/');
    // The crawl reaches nothing; PageSpeed and the grade record the audit without measurements.
    expect(await audit(id)).toEqual({ site_intel: 'done', psi: 'done', vision_audit: 'done' });
    const { body } = await owner.get(`/v1/businesses/${id}/website-audit`).expect(200);
    expect(body.audit).toMatchObject({
      psi: null,
      vision: null,
      qualityScore: null,
      websiteStatus: 'broken',
    });
    expect(body.audit.findings.map((f: { code: string }) => f.code)).toEqual(['site_broken']);
    const listing = (await owner.get('/v1/businesses').query({ website: 'weak', limit: 100 }).expect(200))
      .body;
    expect(listing.items.map((item: { id: string }) => item.id)).toContain(id);
  });

  it('keeps one latest audit per business across crawls', async () => {
    const id = await track('https://www.recrawl-audit.com/');
    await audit(id);
    clock.advance(60_000);
    await audit(id, ['site_intel', 'vision_audit']);
    const rows = await db.select().from(websiteAudits).where(eq(websiteAudits.businessId, id));
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.isLatest)).toHaveLength(1);
    const latest = (await owner.get(`/v1/businesses/${id}/website-audit`).expect(200)).body.audit;
    const [latestRow] = await db
      .select()
      .from(websiteAudits)
      .where(and(eq(websiteAudits.businessId, id), eq(websiteAudits.isLatest, true)));
    expect(latest.id).toBe(latestRow?.id);
  });

  it('skips businesses without a website and keeps workspaces apart', async () => {
    const id = await track(null);
    expect(await audit(id)).toMatchObject({ site_intel: 'skipped', psi: 'skipped', vision_audit: 'skipped' });
    // No website: no audit, and the status says so (scoring and outreach read it).
    expect((await owner.get(`/v1/businesses/${id}/website-audit`).expect(200)).body).toEqual({
      audit: null,
      status: 'none',
    });
    await outsider.get(`/v1/businesses/${id}/website-audit`).expect(404);
  });
});

describe('audit storage', () => {
  it('keeps the newest crawl latest, merges parts per strategy and moves updatedAt', async () => {
    const id = await track('https://www.storage-audit.com/');
    await audit(id);
    clock.advance(60_000);
    await audit(id, ['site_intel', 'vision_audit']);
    const service = t.app.get(WebsiteAuditService);
    const snapshots = t.app.get<WebsiteSnapshotRepository>(WEBSITE_SNAPSHOTS);
    const rows = await db.select().from(websiteAudits).where(eq(websiteAudits.businessId, id));
    const newest = (await snapshots.latest(id))?.id as string;
    const older = rows.find((row) => row.snapshotId !== newest);
    expect(older).toBeDefined();
    // A late write for the older crawl does not take "latest" back.
    const olderSnapshot = await snapshots.byId(older?.snapshotId as string);
    await service.record(olderSnapshot as never, { vision: null });
    const latest = (await owner.get(`/v1/businesses/${id}/website-audit`).expect(200)).body.audit;
    expect(latest.snapshotId).toBe(newest);
    expect(
      (await db.select().from(websiteAudits).where(eq(websiteAudits.businessId, id))).filter(
        (r) => r.isLatest,
      ),
    ).toHaveLength(1);

    // Concurrent parts on one crawl merge; a mobile-only re-check keeps the desktop result.
    const snapshot = await snapshots.latest(id);
    const mobile = await new FakePageSpeed(clock).run('https://slow.example/', 'mobile');
    const grade = (await new FakeVisionGrader(clock).grade('org', snapshot as never)).grade;
    const before = latest.updatedAt;
    await Promise.all([
      service.record(snapshot as never, { psi: { mobile, desktop: null } }),
      service.record(snapshot as never, { vision: { ...grade, overall: 5 } }),
    ]);
    const merged = await t.app.get<WebsiteAuditRepository>(WEBSITE_AUDITS).latest(id);
    expect(merged?.psi?.mobile?.scores.performance).toBe(28);
    expect(merged?.psi?.desktop?.scores.performance).toBe(95);
    expect(merged?.vision?.overall).toBe(5);
    expect(Date.parse(merged?.updatedAt.toISOString() ?? '')).toBeGreaterThan(Date.parse(before));
  });

  it('filters weak on the latest audit only', async () => {
    const id = await track('https://www.history-audit.com/');
    await audit(id);
    clock.advance(60_000);
    await audit(id, ['site_intel', 'vision_audit']);
    // An older audit said weak; the latest says strong.
    await db
      .update(websiteAudits)
      .set({ websiteStatus: 'weak' })
      .where(and(eq(websiteAudits.businessId, id), eq(websiteAudits.isLatest, false)));
    const listing = (await owner.get('/v1/businesses').query({ website: 'weak', limit: 100 }).expect(200))
      .body;
    expect(listing.items.map((item: { id: string }) => item.id)).not.toContain(id);
    await db
      .update(websiteAudits)
      .set({ websiteStatus: 'parked' })
      .where(and(eq(websiteAudits.businessId, id), eq(websiteAudits.isLatest, true)));
    const parked = (await owner.get('/v1/businesses').query({ website: 'weak', limit: 100 }).expect(200))
      .body;
    expect(parked.items.map((item: { id: string }) => item.id)).not.toContain(id);
  });

  it('reads the primary category attributes from the root down, the child overriding its ancestors', async () => {
    const id = await track('https://www.facts-audit.com/');
    const [root] = await db
      .insert(categories)
      .values({
        slug: 'bf030_root',
        path: 'bf030_root',
        labels: { en: 'Root', fr: 'Racine' },
        attributes: { appointmentBased: true, tourismFacing: true },
      })
      .returning();
    const [child] = await db
      .insert(categories)
      .values({
        slug: 'bf030_child',
        parentId: root?.id,
        path: 'bf030_root.bf030_child',
        labels: { en: 'Child', fr: 'Enfant' },
        attributes: { appointmentBased: false },
      })
      .returning();
    await db.insert(businessCategories).values({
      businessId: id,
      categoryId: child?.id as string,
      isPrimary: true,
      confidence: 1,
      source: 'manual',
    });
    const facts = await t.app.get<WebsiteAuditRepository>(WEBSITE_AUDITS).businessFacts(id);
    expect(facts).toMatchObject({
      categoryAttributes: { appointmentBased: false, tourismFacing: true },
      servesFood: false,
      categoryLabel: 'Child',
    });
    const none = await t.app.get<WebsiteAuditRepository>(WEBSITE_AUDITS).businessFacts(await track(null));
    expect(none).toMatchObject({ categoryAttributes: {}, servesFood: false, categoryLabel: null });
  });
});
