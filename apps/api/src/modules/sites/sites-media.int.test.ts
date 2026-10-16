import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { newId, signSiteViewToken } from '@bf/contracts';
import type { DbClient } from '@bf/db';
import {
  businesses,
  orgBusinesses,
  outboxEvents,
  siteAssets,
  siteViewDaily,
  websiteSnapshots,
} from '@bf/db/schema';
import { QUEUES } from '@bf/queue';
import { aBusiness } from '@bf/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplicationContext } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import request from 'supertest';
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
import { InMemoryObjectStorage } from '../platform/storage/object-storage.ts';
import {
  PUBLIC_FILES,
  SITE_ARTIFACTS,
  SITE_ASSETS_REPOSITORY,
  SITE_ORIGINALS,
  SITE_THUMBNAILS_REPOSITORY,
  SITE_VIEW_COUNTER,
  SITE_VIEWS_REPOSITORY,
  type SiteAssetsRepository,
  type SiteThumbnailsRepository,
  type SiteViewCounter,
  type SiteViewsRepository,
  UPLOAD_SIGNER,
} from './application/ports.ts';
import { staleCutoffs } from './application/site-assets.ts';
import { SiteViewsFlusher } from './application/site-views.ts';
import {
  SCREENSHOT_DELAY_MS,
  SITES_EXPIRY_AUTOSTART,
  SITES_VIEWS_AUTOSTART,
} from './infrastructure/bullmq-site-jobs.ts';
import { FakeUploadSigner, InMemoryPublicFiles } from './infrastructure/site-asset-storage.ts';

// Sites media (BF-035 part 2) end to end: image uploads (checked bytes, processed variants, deletion only when no
// version uses them), pictures of published sites through the worker, and anonymous view counts.

const fixtures = join(
  dirname(createRequire(import.meta.url).resolve('@bf/site-schema/package.json')),
  'fixtures',
);
const salonSpec = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(fixtures, 'salon-gustavia.json'), 'utf8'));
const ASSETS_BASE = 'https://assets.bf-sites.test';
const NOW_ISO = '2026-10-14T12:00:00.000Z';
const VIEW_SECRET = 'view-secret-for-tests-only-0123456789abcdef';
const ENV = {
  SITES_BASE_DOMAIN: 'sites.test',
  SITES_ASSETS_BASE_URL: ASSETS_BASE,
  SITES_VIEW_TOKEN_SECRET: VIEW_SECRET,
  FAKE_SITE_INTEL: 'true',
  // supertest connects from the loopback: the tests name each visitor's address in X-Forwarded-For.
  AUTH_TRUSTED_PROXIES: '127.0.0.1,::1,::ffff:127.0.0.1',
};

const mailer = new FakeMailer();
const originals = new InMemoryObjectStorage();
const artifacts = new InMemoryObjectStorage();
const publicFiles = new InMemoryPublicFiles(ASSETS_BASE);
const overrides = [
  { token: SITE_ORIGINALS, value: originals },
  { token: SITE_ARTIFACTS, value: artifacts },
  { token: PUBLIC_FILES, value: publicFiles },
  { token: UPLOAD_SIGNER, value: new FakeUploadSigner() },
  { token: SCREENSHOT_DELAY_MS, value: 0 },
];
let t: TestApp;
let worker: INestApplicationContext;
let db: DbClient;
let member: Browser;
let viewer: Browser;
let outsider: Browser;
let org: string;

const jpeg = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#c2410c' } })
    .withMetadata({ exif: { IFD0: { Copyright: 'Someone' } } })
    .jpeg()
    .toBuffer();

async function newSite(name: string): Promise<{ id: string; v1: string }> {
  const business = aBusiness({ displayName: name, locality: 'Gustavia' });
  await db.insert(businesses).values(business);
  await db.insert(orgBusinesses).values({ organizationId: org, businessId: business.id, addedVia: 'search' });
  const { body } = await member.post('/v1/sites', { businessId: business.id, spec: salonSpec() }).expect(201);
  return { id: body.id, v1: body.currentVersion.id };
}

/** Polls until `check` returns a value (the outbox and the worker run asynchronously). */
async function eventually<T>(check: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 21, env: ENV, overrides });
  db = t.app.get(DB_CLIENT);
  worker = await createTestWorker(t, {
    mailer,
    env: ENV,
    overrides: [
      ...overrides,
      { token: SITES_EXPIRY_AUTOSTART, value: false },
      { token: SITES_VIEWS_AUTOSTART, value: false },
    ],
  });
  for (const queue of [
    QUEUES.sitesAssetProcess.name,
    QUEUES.sitesScreenshot.name,
    QUEUES.sitesViews.name,
    QUEUES.sitesAssetCollect.name,
    QUEUES.sitesAssetAnalyze.name,
  ])
    await worker.get<Queue>(getQueueToken(queue)).obliterate({ force: true });
  member = await signUpVerified(t, mailer, 'member@media.test', 'Mia Member');
  org = await createWorkspace(member, 'Agence Media');
  viewer = (await inviteAndJoin(t, mailer, member, 'viewer@media.test', 'viewer')).client;
  outsider = await signUpVerified(t, mailer, 'outsider@media.test', 'Oscar Outsider');
  await createWorkspace(outsider, 'Ailleurs');
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await t?.close();
});

describe('site images', () => {
  it('uploads, checks and processes an image into stripped WebP and AVIF variants, never enlarged', async () => {
    const site = await newSite('Images');
    const bytes = await jpeg(1000, 600);
    const upload = await member
      .post(`/v1/sites/${site.id}/assets`, {
        mime: 'image/jpeg',
        bytes: bytes.length,
        license: 'uploaded',
        alt: { fr: 'Le salon', en: 'The salon' },
      })
      .expect(201);
    expect(upload.body).toMatchObject({ method: 'PUT', asset: { status: 'pending', license: 'uploaded' } });
    const assetId: string = upload.body.asset.id;
    // Not uploaded yet.
    const early = await member.post(`/v1/sites/${site.id}/assets/${assetId}/finalize`).expect(409);
    expect(early.body).toMatchObject({ reason: 'ASSET_NOT_UPLOADED' });

    const [row] = await db.select().from(siteAssets).where(eq(siteAssets.id, assetId));
    expect(row?.storageKey).toBe(`orgs/${org}/sites/${site.id}/assets/${assetId}/original`);
    await originals.put(row?.storageKey ?? '', bytes, 'image/jpeg');
    const finalized = await member.post(`/v1/sites/${site.id}/assets/${assetId}/finalize`).expect(200);
    expect(finalized.body).toMatchObject({ status: 'processing', width: 1000, height: 600 });

    const ready = await eventually(async () => {
      const { body } = await member.get(`/v1/sites/${site.id}/assets`).expect(200);
      const asset = body.items.find((item: { id: string }) => item.id === assetId);
      return asset?.status === 'ready' ? asset : undefined;
    });
    // 480 and 768 fit, and the image's own 1000; 1200 and 1920 would enlarge it, so they are not made.
    expect(ready.variants.map((v: { width: number; format: string }) => `${v.width}.${v.format}`)).toEqual([
      '480.webp',
      '480.avif',
      '768.webp',
      '768.avif',
      '1000.webp',
      '1000.avif',
    ]);
    expect(ready.publicUrl).toBe(`${ASSETS_BASE}/sites/${site.id}/${assetId}/1000.webp`);
    expect(ready.dominantColors).toEqual([expect.stringMatching(/^#[0-9a-f]{6}$/)]);
    const variant = publicFiles.files.get(`sites/${site.id}/${assetId}/768.webp`);
    expect(variant?.contentType).toBe('image/webp');
    const metadata = await sharp(variant?.body).metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: 768 });
    expect(metadata.exif).toBeUndefined();
  });

  it('refuses a file that is not the declared image type, and deletes it', async () => {
    const site = await newSite('Wrong Type');
    const html = Buffer.from('<html><script>alert(1)</script></html>'.padEnd(64, ' '));
    const upload = await member
      .post(`/v1/sites/${site.id}/assets`, { mime: 'image/png', bytes: html.length, license: 'uploaded' })
      .expect(201);
    const assetId: string = upload.body.asset.id;
    const key = `orgs/${org}/sites/${site.id}/assets/${assetId}/original`;
    await originals.put(key, html, 'image/png');
    const refused = await member.post(`/v1/sites/${site.id}/assets/${assetId}/finalize`).expect(422);
    expect(refused.body).toMatchObject({ reason: 'ASSET_TYPE_MISMATCH' });
    expect(await originals.get(key)).toBeUndefined();
    const [row] = await db
      .select({ status: siteAssets.status })
      .from(siteAssets)
      .where(eq(siteAssets.id, assetId));
    expect(row?.status).toBe('failed');
  });

  it('refuses an upload of another size than declared, and an unsupported type at the start', async () => {
    const site = await newSite('Wrong Size');
    const bytes = await jpeg(200, 200);
    const upload = await member
      .post(`/v1/sites/${site.id}/assets`, { mime: 'image/jpeg', bytes: bytes.length + 10, license: 'stock' })
      .expect(201);
    await originals.put(
      `orgs/${org}/sites/${site.id}/assets/${upload.body.asset.id}/original`,
      bytes,
      'image/jpeg',
    );
    const refused = await member
      .post(`/v1/sites/${site.id}/assets/${upload.body.asset.id}/finalize`)
      .expect(422);
    expect(refused.body).toMatchObject({ reason: 'ASSET_SIZE_MISMATCH' });
    await member
      .post(`/v1/sites/${site.id}/assets`, { mime: 'image/svg+xml', bytes: 100, license: 'uploaded' })
      .expect(422);
  });

  it('deletes an image only when no version of the site uses it, and hides it from other workspaces', async () => {
    const site = await newSite('In Use');
    const bytes = await jpeg(640, 400);
    const upload = await member
      .post(`/v1/sites/${site.id}/assets`, { mime: 'image/jpeg', bytes: bytes.length, license: 'owner_site' })
      .expect(201);
    const assetId: string = upload.body.asset.id;
    await originals.put(`orgs/${org}/sites/${site.id}/assets/${assetId}/original`, bytes, 'image/jpeg');
    await member.post(`/v1/sites/${site.id}/assets/${assetId}/finalize`).expect(200);
    const ready = await eventually(async () => {
      const { body } = await member.get(`/v1/sites/${site.id}/assets`).expect(200);
      return body.items[0]?.status === 'ready' ? body.items[0] : undefined;
    });
    await outsider.get(`/v1/sites/${site.id}/assets`).expect(404);
    await outsider.delete(`/v1/sites/${site.id}/assets/${assetId}`).expect(404);

    const spec = salonSpec();
    const assets = spec.assets as { url: string; width: number; height: number }[];
    Object.assign(assets[1] as object, { url: ready.publicUrl, width: 480, height: 300 });
    await member.post(`/v1/sites/${site.id}/versions`, { spec, baseVersionId: site.v1 }).expect(201);
    const inUse = await member.delete(`/v1/sites/${site.id}/assets/${assetId}`).expect(409);
    expect(inUse.body).toMatchObject({ reason: 'ASSET_IN_USE' });

    const unused = await member
      .post(`/v1/sites/${site.id}/assets`, { mime: 'image/jpeg', bytes: 10, license: 'uploaded' })
      .expect(201);
    await member.delete(`/v1/sites/${site.id}/assets/${unused.body.asset.id}`).expect(204);
    const left = (await member.get(`/v1/sites/${site.id}/assets`).expect(200)).body.items;
    expect(left.map((item: { id: string }) => item.id)).toEqual([assetId]);
  });
});

describe('image sourcing (BF-038)', () => {
  /** A crawl of the site's business, as BF-026 stores it: two photos, a provider photo and a logo. */
  async function crawled(siteId: string) {
    const [site] = await db.execute<{ business_id: string }>(
      sql`SELECT business_id FROM sites WHERE id = ${siteId}`,
    );
    const empty = {};
    await db.insert(websiteSnapshots).values({
      businessId: site?.business_id as string,
      url: 'https://salon-lumiere.example/',
      fetchedAt: new Date(NOW_ISO),
      reachability: 'ok',
      tls: empty as never,
      security: empty as never,
      languages: empty as never,
      pages: [],
      contacts: empty as never,
      socials: [],
      booking: empty as never,
      ordering: empty as never,
      chat: empty as never,
      analytics: empty as never,
      tech: [],
      freshness: empty as never,
      mobile: empty as never,
      performanceHints: empty as never,
      links: empty as never,
      noSolicitation: empty as never,
      logoCandidates: [
        { url: 'https://salon-lumiere.example/logo.png', source: 'img-logo', width: 400, height: 160 },
      ],
      imageCandidates: [
        { url: 'https://salon-lumiere.example/img/terrasse.jpg', alt: 'Terrasse', width: 1600, height: 1000 },
        { url: 'https://salon-lumiere.example/img/salon.jpg', alt: null, width: 1600, height: 1000 },
        { url: 'https://lh3.googleusercontent.com/p/abc=w800', alt: null, width: 800, height: 600 },
      ],
      warnings: [],
      contentHash: 'test',
    });
  }

  it('collects the website’s images through the worker, preview-only, then ranks and analyses them', async () => {
    const site = await newSite('Salon Sources');
    await crawled(site.id);
    await member.post(`/v1/sites/${site.id}/assets/refresh`, {}).expect(202);
    const ready = await eventually(async () => {
      const { body } = await member.get(`/v1/sites/${site.id}/assets`).expect(200);
      const items = body.items as { status: string; source: string; kind: string; analysis: unknown }[];
      return items.length === 3 && items.every((item) => item.status === 'ready' && item.analysis)
        ? items
        : undefined;
    });
    expect(ready.map((item) => item.kind).sort()).toEqual(['image', 'image', 'logo']);
    const rows = await db.select().from(siteAssets).where(eq(siteAssets.siteId, site.id));
    // The provider photo never reached the library.
    expect(rows.some((row) => row.sourceUrl?.includes('googleusercontent'))).toBe(false);
    for (const row of rows) {
      expect(row).toMatchObject({
        source: 'owner_site',
        license: 'owner_site',
        restrictions: ['preview_only'],
      });
      expect(row.alt).toMatchObject({ fr: expect.any(String), en: expect.any(String) });
    }
    const { body: hero } = await member.get(`/v1/sites/${site.id}/asset-suggestions?role=hero`).expect(200);
    expect(hero.items).toHaveLength(2);
    expect(hero.items[0].reasons.length).toBeGreaterThan(0);

    // Collecting again adds nothing (one copy per source URL), and no wordmark: a logo was found.
    await member.post(`/v1/sites/${site.id}/assets/refresh`, {}).expect(202);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await db.select().from(siteAssets).where(eq(siteAssets.siteId, site.id))).toHaveLength(3);

    // Ownership: confirmed by someone who may publish, recorded with its method, preview_only lifted.
    const image = rows.find((row) => row.kind === 'image');
    await viewer
      .post(`/v1/sites/${site.id}/assets/${image?.id}/confirm-ownership`, { method: 'claim_form' })
      .expect(403);
    const { body: confirmed } = await member
      .post(`/v1/sites/${site.id}/assets/${image?.id}/confirm-ownership`, { method: 'claim_form' })
      .expect(200);
    expect(confirmed.restrictions).toEqual([]);
    expect(confirmed.ownership).toMatchObject({ method: 'claim_form' });
    await outsider.get(`/v1/sites/${site.id}/asset-suggestions?role=hero`).expect(404);
  }, 60_000);

  it('draws a wordmark when the business has no logo and no website', async () => {
    const site = await newSite('Salon Sans Logo');
    await member.post(`/v1/sites/${site.id}/assets/refresh`, {}).expect(202);
    const marks = await eventually(async () => {
      const rows = await db.select().from(siteAssets).where(eq(siteAssets.siteId, site.id));
      return rows.length === 2 && rows.every((row) => row.status === 'ready') ? rows : undefined;
    });
    expect(marks.map((row) => [row.kind, row.source, row.license])).toEqual([
      ['logo', 'wordmark', 'system_generated'],
      ['logo', 'wordmark', 'system_generated'],
    ]);
  }, 60_000);
});

describe('image permissions and refusals', () => {
  it('lets viewers list images but not upload, finalize or delete them, and hides them from other workspaces', async () => {
    const site = await newSite('Image Rights');
    const upload = await member
      .post(`/v1/sites/${site.id}/assets`, { mime: 'image/png', bytes: 100, license: 'uploaded' })
      .expect(201);
    const assetId: string = upload.body.asset.id;
    await viewer.get(`/v1/sites/${site.id}/assets`).expect(200);
    await viewer
      .post(`/v1/sites/${site.id}/assets`, { mime: 'image/png', bytes: 100, license: 'uploaded' })
      .expect(403);
    await viewer.post(`/v1/sites/${site.id}/assets/${assetId}/finalize`).expect(403);
    await viewer.delete(`/v1/sites/${site.id}/assets/${assetId}`).expect(403);
    await outsider.post(`/v1/sites/${site.id}/assets/${assetId}/finalize`).expect(404);
  });

  it('refuses an image that cannot be decoded, and a second finalize of a refused image', async () => {
    const site = await newSite('Unreadable');
    // A JPEG signature followed by garbage: the type matches, the decoder fails.
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
    const upload = await member
      .post(`/v1/sites/${site.id}/assets`, { mime: 'image/jpeg', bytes: bytes.length, license: 'uploaded' })
      .expect(201);
    const assetId: string = upload.body.asset.id;
    await originals.put(`orgs/${org}/sites/${site.id}/assets/${assetId}/original`, bytes, 'image/jpeg');
    const refused = await member.post(`/v1/sites/${site.id}/assets/${assetId}/finalize`).expect(422);
    expect(refused.body).toMatchObject({ reason: 'ASSET_UNREADABLE' });
    const again = await member.post(`/v1/sites/${site.id}/assets/${assetId}/finalize`).expect(409);
    expect(again.body).toMatchObject({ reason: 'ASSET_FAILED' });
  });
});

describe('pictures of published sites', () => {
  it('photographs a site after it is published and serves the pictures to the workspace only', async () => {
    const site = await newSite('Pictures');
    expect((await member.get(`/v1/sites/${site.id}`).expect(200)).body.thumbnails).toBeNull();
    await member.get(`/v1/sites/${site.id}/thumbnails/desktop`).expect(404);
    const preview = await member.post(`/v1/sites/${site.id}/preview`, { versionId: site.v1 }).expect(201);
    const thumbnails = await eventually(async () => {
      const { body } = await member.get(`/v1/sites/${site.id}`).expect(200);
      return body.thumbnails ?? undefined;
    });
    expect(thumbnails).toMatchObject({ publicationId: preview.body.id, desktop: true, mobile: true });
    const desktop = await member.get(`/v1/sites/${site.id}/thumbnails/desktop`).expect(200);
    expect(desktop.headers['content-type']).toBe('image/png');
    expect(desktop.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect((await sharp(desktop.body).metadata()).width).toBe(64);
    await member.get(`/v1/sites/${site.id}/thumbnails/tablet`).expect(400);
    await outsider.get(`/v1/sites/${site.id}/thumbnails/desktop`).expect(404);
  });
});

describe('views', () => {
  const beacon = (body: object, ip = '203.0.113.7', userAgent = 'Mozilla/5.0 (Test) visitor-a') =>
    request(t.app.getHttpServer())
      .post('/v1/public/sites/views')
      .set('User-Agent', userAgent)
      .set('X-Forwarded-For', ip)
      .set('Origin', 'https://salon-k3x9p2.sites.test')
      .send(body);
  const viewedEvents = (siteId: string) =>
    db
      .select({ type: outboxEvents.type, payload: outboxEvents.payload, context: outboxEvents.context })
      .from(outboxEvents)
      .where(sql`${outboxEvents.type} = 'site.viewed' AND ${outboxEvents.payload}->>'siteId' = ${siteId}`);

  it('counts anonymous views per day with unique visitors, stores no IP or user agent, and emits hourly events', async () => {
    const site = await newSite('Views');
    const token = await signSiteViewToken(site.id, VIEW_SECRET);
    await beacon({ token, pageId: 'home', locale: 'fr', c: 'camp-1' }).expect(204);
    // Another browser on the same network is the same visitor.
    await beacon({ token, pageId: 'home', locale: 'fr' }, '203.0.113.7', 'Mozilla/5.0 (Other)').expect(204);
    await beacon(
      { token, pageId: 'services', locale: 'en' },
      '198.51.100.9',
      'Mozilla/5.0 (Test) visitor-b',
    ).expect(204);
    // A forged token or another site's token counts nothing, and says nothing.
    const forged = `${token.slice(0, -4)}AAAA`;
    await beacon({ token: forged, pageId: 'home', locale: 'fr' }).expect(204);
    await beacon({ token: 'v1.nope.nope', pageId: 'home', locale: 'fr' }).expect(204);
    await beacon({ token, pageId: 'Home Page!', locale: 'fr' }).expect(422);

    const result = await worker.get(SiteViewsFlusher).flush();
    expect(result.days).toBeGreaterThanOrEqual(1);
    const [day] = await db.select().from(siteViewDaily).where(eq(siteViewDaily.siteId, site.id));
    expect(day).toMatchObject({
      pageViews: 3,
      uniqueEstimate: 2,
      byLocale: { fr: 2, en: 1 },
      byCampaign: { 'camp-1': 1 },
    });
    // Nothing about visitors in the database: no column holds an IP or a user agent, and no event mentions them.
    const dump = JSON.stringify(await db.select().from(siteViewDaily));
    expect(dump).not.toMatch(/visitor-a|203\.0\.113|198\.51|Mozilla/);
    // The app's clock is two days behind the worker's: that hour is over, so its event is out.
    const events = await viewedEvents(site.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      pageViews: 3,
      uniqueEstimate: 2,
      hourStart: '2026-10-14T12:00:00.000Z',
    });
    expect(JSON.stringify(events)).not.toMatch(/visitor-a|Mozilla|203\.0\.113|198\.51/);

    // A late view of that hour and two more flushes: the day's totals grow, the hour's event is never emitted again.
    await beacon({ token, pageId: 'home', locale: 'fr' }, '192.0.2.44').expect(204);
    await worker.get(SiteViewsFlusher).flush();
    expect((await worker.get(SiteViewsFlusher).flush()).events).toBe(0);
    expect(await viewedEvents(site.id)).toHaveLength(1);
    const detail = (await member.get(`/v1/sites/${site.id}`).expect(200)).body;
    expect(detail.views).toEqual({
      last7Days: { pageViews: 4, uniqueEstimate: 3 },
      last30Days: { pageViews: 4, uniqueEstimate: 3 },
    });
  });

  it('reads the renderer’s text/plain beacon (a simple cross-origin request, no preflight)', async () => {
    const site = await newSite('Plain Beacon');
    const token = await signSiteViewToken(site.id, VIEW_SECRET);
    await request(t.app.getHttpServer())
      .post('/v1/public/sites/views')
      .set('Content-Type', 'text/plain;charset=UTF-8')
      .set('X-Forwarded-For', '203.0.113.90')
      .set('Origin', 'https://salon-k3x9p2.sites.test')
      .send(JSON.stringify({ token, pageId: 'home', locale: 'fr' }))
      .expect(204);
    // From another page (any site could replay a public token), or without an Origin: nothing is counted.
    for (const origin of ['https://evil.example', 'https://a.b.sites.test', null]) {
      const call = request(t.app.getHttpServer())
        .post('/v1/public/sites/views')
        .set('Content-Type', 'text/plain')
        .set('X-Forwarded-For', '203.0.113.91');
      await (origin ? call.set('Origin', origin) : call)
        .send(JSON.stringify({ token, pageId: 'home', locale: 'fr' }))
        .expect(204);
    }
    await worker.get(SiteViewsFlusher).flush();
    const [day] = await db.select().from(siteViewDaily).where(eq(siteViewDaily.siteId, site.id));
    expect(day?.pageViews).toBe(1);
  });

  it('counts at most 30 views a day per visitor, and at most 50 campaigns (the rest as ~other)', async () => {
    const site = await newSite('Capped Views');
    const token = await signSiteViewToken(site.id, VIEW_SECRET);
    for (let n = 0; n < 35; n += 1)
      await beacon({ token, pageId: 'home', locale: 'fr' }, '203.0.113.50').expect(204);
    for (let n = 0; n < 52; n += 1)
      await beacon({ token, pageId: 'home', locale: 'fr', c: `camp-${n}` }, `198.51.100.${n + 1}`).expect(
        204,
      );
    await worker.get(SiteViewsFlusher).flush();
    const [day] = await db.select().from(siteViewDaily).where(eq(siteViewDaily.siteId, site.id));
    expect(day?.pageViews).toBe(30 + 52);
    expect(Object.keys(day?.byCampaign ?? {})).toHaveLength(51);
    expect(day?.byCampaign['~other']).toBe(2);
  });

  it('keeps a day pending when a view arrives while it is being written (nothing lost)', async () => {
    const counter = worker.get<SiteViewCounter>(SITE_VIEW_COUNTER);
    const { id: siteId } = await newSite('Pending Views');
    const view = (visitor: string) =>
      counter.record({ siteId, day: '2026-10-14', hour: '2026-10-14T12:00:00.000Z', visitor, locale: 'fr' });
    const pendingFor = async () => (await counter.pendingDays(10_000)).filter((day) => day.siteId === siteId);
    await view('a');
    const read = await pendingFor();
    await view('b');
    await counter.clearDays(read);
    expect(await pendingFor()).toHaveLength(1);
    await counter.clearDays(await pendingFor());
    expect(await pendingFor()).toEqual([]);
  });
});

describe('pictures of an ended publication', () => {
  it('are not stored once the publication is no longer active', async () => {
    const thumbnails = worker.get<SiteThumbnailsRepository>(SITE_THUMBNAILS_REPOSITORY);
    const site = await newSite('Old Pictures');
    const preview = await member.post(`/v1/sites/${site.id}/preview`, { versionId: site.v1 }).expect(201);
    await member.post(`/v1/sites/${site.id}/unpublish`, { environment: 'preview' }).expect(204);
    const late = { publicationId: preview.body.id, takenAt: NOW_ISO, desktopKey: null, mobileKey: null };
    expect(await thumbnails.setIfActive(site.id, late)).toBe(false);
  });
});

describe('maintenance queries', () => {
  it('fails only images whose job died or never started for a day, and prunes old hour claims in batches', async () => {
    const site = await newSite('Maintenance');
    const assets = worker.get<SiteAssetsRepository>(SITE_ASSETS_REPOSITORY);
    const row = (name: string, startedMinutesAgo: number | null, createdHoursAgo = 0) => ({
      id: newId(),
      organizationId: org,
      siteId: site.id,
      storageKey: `orgs/${org}/sites/${site.id}/assets/${name}/original`,
      mime: 'image/jpeg',
      license: 'uploaded' as const,
      status: 'processing' as const,
      processingStartedAt:
        startedMinutesAgo === null ? null : new Date(Date.now() - startedMinutesAgo * 60_000),
      createdAt: new Date(Date.now() - createdHoursAgo * 3_600_000),
    });
    const died = row('died', 45);
    const running = row('running', 5);
    const queued = row('queued', null, 2);
    const lost = row('lost', null, 30);
    // Around the one-day cutoff for a job that never started.
    const almostDay = row('almost-a-day', null, 23 + 50 / 60);
    const pastDay = row('past-a-day', null, 24 + 10 / 60);
    await db.insert(siteAssets).values([died, running, queued, lost, almostDay, pastDay]);
    const failed = await assets.failStale(staleCutoffs(new Date()), 100);
    expect(failed.map((asset) => asset.id).sort()).toEqual([died.id, lost.id, pastDay.id].sort());
    expect(failed.every((asset) => asset.status === 'failed')).toBe(true);
    expect((await assets.lock(org, site.id, running.id))?.status).toBe('processing');

    const views = worker.get<SiteViewsRepository>(SITE_VIEWS_REPOSITORY);
    const now = Date.now();
    const hour = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
    for (const hoursAgo of [100, 90, 80, 1])
      expect(await views.claimHour(site.id, hour(hoursAgo))).toBe(true);
    const before = hour(72);
    expect(await views.pruneHours(before, 2)).toBe(2);
    expect(await views.pruneHours(before, 2)).toBe(1);
    expect(await views.pruneHours(before, 2)).toBe(0);
    expect(await views.claimHour(site.id, hour(1))).toBe(false);
  });
});
