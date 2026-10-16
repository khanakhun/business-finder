import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { encodeCursor, newId } from '@bf/contracts';
import { closeDb, createDb, type DbClient } from '@bf/db';
import {
  businesses,
  orgBusinesses,
  orgSettings,
  outboxEvents,
  siteAssets,
  sitePublications,
  sites,
  siteVersions,
} from '@bf/db/schema';
import { QUEUES } from '@bf/queue';
import { aBusiness } from '@bf/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplicationContext } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
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
import { SITES_EXPIRY_AUTOSTART, SitesExpiryScheduler } from './infrastructure/bullmq-site-jobs.ts';

// Sites (BF-035) end to end: roles and workspaces, versions with optimistic concurrency and immutability in the
// database, publications, the renderer's read-only views, expiry through the worker, rollback, archive and diffs.

const fixtures = join(
  dirname(createRequire(import.meta.url).resolve('@bf/site-schema/package.json')),
  'fixtures',
);
const salonSpec = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(fixtures, 'salon-gustavia.json'), 'utf8'));
const theme = (radius: string) => ({ ...(salonSpec().theme as object), radius });
const NOW = '2026-10-14T12:00:00.000Z';
const ENV = { SITES_BASE_DOMAIN: 'sites.test', SITES_ASSETS_BASE_URL: 'https://assets.bf-sites.test' };
const SLUG = /^[a-z0-9-]+-[a-z2-9]{6}$/;

const mailer = new FakeMailer();
let t: TestApp;
let worker: INestApplicationContext;
let db: DbClient;
let owner: Browser;
let member: Browser;
let viewer: Browser;
let outsider: Browser;
let org: string;

async function track(overrides: Parameters<typeof aBusiness>[0] = {}, workspace = org): Promise<string> {
  const business = aBusiness({ displayName: 'Salon Lumière', locality: 'Gustavia', ...overrides });
  await db.insert(businesses).values(business);
  await db
    .insert(orgBusinesses)
    .values({ organizationId: workspace, businessId: business.id, addedVia: 'search' });
  return business.id;
}

async function newSite(name: string): Promise<{ id: string; v1: string }> {
  const businessId = await track({ displayName: name });
  const { body } = await member.post('/v1/sites', { businessId, spec: salonSpec() }).expect(201);
  return { id: body.id, v1: body.currentVersion.id };
}

/** The database's own error message (Drizzle wraps it: "Failed query: …", the cause is Postgres's). */
async function dbError(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(error);
  }
  return 'no error';
}

/** A connection as the renderer's role, to the test database (read-only by default, like the renderer's). */
function rendererDb(readOnly = true): DbClient {
  const url = new URL(t.env.DATABASE_URL);
  url.username = 'bf_sites_ro';
  url.password = 'bf_sites_ro_test_only';
  return createDb({ url: url.href, max: 1, readOnly });
}

const eventsOf = async (siteId: string) =>
  (
    await db
      .select({ type: outboxEvents.type })
      .from(outboxEvents)
      .where(sql`${outboxEvents.payload}->>'siteId' = ${siteId}`)
  ).map((event) => event.type);

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 20, env: ENV });
  db = t.app.get(DB_CLIENT);
  worker = await createTestWorker(t, {
    mailer,
    env: ENV,
    // The system clock: the outbox relay delivers events once their time has come (a fixed past clock never does).
    // The test asks for the hourly expiry itself.
    overrides: [{ token: SITES_EXPIRY_AUTOSTART, value: false }],
  });
  for (const queue of [QUEUES.sitesExpire.name, QUEUES.sitesRevalidate.name])
    await worker.get<Queue>(getQueueToken(queue)).obliterate({ force: true });
  owner = await signUpVerified(t, mailer, 'owner@sites.test', 'Olga Owner');
  org = await createWorkspace(owner, 'Agence Sites');
  member = (await inviteAndJoin(t, mailer, owner, 'member@sites.test', 'member')).client;
  viewer = (await inviteAndJoin(t, mailer, owner, 'viewer@sites.test', 'viewer')).client;
  outsider = await signUpVerified(t, mailer, 'outsider@sites.test', 'Oscar Outsider');
  await createWorkspace(outsider, 'Ailleurs');
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await t?.close();
});

describe('sites and versions', () => {
  it('creates a business’s site once, with an unguessable slug, and refuses a spec for an existing site', async () => {
    const businessId = await track();
    const created = await member.post('/v1/sites', { businessId, spec: salonSpec() }).expect(201);
    expect(created.body).toMatchObject({
      businessId,
      businessName: 'Salon Lumière',
      status: 'draft',
      currentVersion: { versionNumber: 1 },
      currentVersionSummary: { authorType: 'user', changeSummary: 'First version' },
      publications: [],
    });
    expect(created.body.slug).toMatch(/^salon-lumiere-gustavia-[a-z2-9]{6}$/);
    const again = await member.post('/v1/sites', { businessId }).expect(200);
    expect(again.body.id).toBe(created.body.id);
    const conflict = await member.post('/v1/sites', { businessId, spec: salonSpec() }).expect(409);
    expect(conflict.body).toMatchObject({ code: 'CONFLICT', reason: 'SITE_EXISTS' });
    const other = await member.post('/v1/sites', { businessId, forceNew: true }).expect(201);
    expect(other.body.slug).toMatch(SLUG);
    expect(other.body.slug).not.toBe(created.body.slug);
  });

  it('refuses an invalid spec with each error at its path and code, and creates no site', async () => {
    const businessId = await track({ displayName: 'Invalid Spec' });
    const spec = salonSpec();
    (spec.seo as { title: Record<string, string> }).title.en = 'Visit www.evil.example today';
    const refused = await member.post('/v1/sites', { businessId, spec }).expect(422);
    expect(refused.body).toMatchObject({ code: 'VALIDATION_FAILED', reason: 'SITE_SPEC_INVALID' });
    expect(refused.body.errors).toContainEqual(
      expect.objectContaining({ path: ['seo', 'title', 'en'], code: 'external_url' }),
    );
    expect((await member.get(`/v1/sites?businessId=${businessId}`).expect(200)).body.items).toEqual([]);
  });

  it('saves versions only from the current one (409 with its id) and applies operations atomically', async () => {
    const site = await newSite('Concurrency');
    // The same spec again: jsonb reorders keys, the summary still says nothing changed.
    const v2 = await member
      .post(`/v1/sites/${site.id}/versions`, { spec: salonSpec(), baseVersionId: site.v1 })
      .expect(201);
    expect(v2.body).toMatchObject({ versionNumber: 2, parentVersionId: site.v1, changeSummary: 'No change' });
    const stale = await member
      .post(`/v1/sites/${site.id}/versions`, { spec: salonSpec(), baseVersionId: site.v1 })
      .expect(409);
    expect(stale.body).toMatchObject({ code: 'SITE_VERSION_CONFLICT', currentVersionId: v2.body.id });
    const v3 = await member
      .post(`/v1/sites/${site.id}/operations`, {
        baseVersionId: v2.body.id,
        operations: [{ op: 'setTheme', theme: theme('full') }],
      })
      .expect(201);
    expect(v3.body).toMatchObject({ versionNumber: 3, changeSummary: 'theme updated' });
    const refused = await member
      .post(`/v1/sites/${site.id}/operations`, {
        baseVersionId: v3.body.id,
        operations: [{ op: 'removePage', pageId: 'nowhere' }],
      })
      .expect(422);
    expect(refused.body).toMatchObject({ reason: 'SITE_OPERATION_REFUSED' });
    const versions = await viewer.get(`/v1/sites/${site.id}/versions?limit=2`).expect(200);
    expect(versions.body.items.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([3, 2]);
    const next = await viewer
      .get(`/v1/sites/${site.id}/versions?limit=2&cursor=${versions.body.nextCursor}`)
      .expect(200);
    expect(next.body.items.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([1]);
    const diff = await viewer
      .get(`/v1/sites/${site.id}/diff?from=${v2.body.id}&to=${v3.body.id}`)
      .expect(200);
    expect(diff.body).toMatchObject({ summary: 'theme updated', sections: ['theme'] });
  });

  it('serializes concurrent edits and creates: one wins, the others conflict or find it', async () => {
    const site = await newSite('Race');
    const saves = await Promise.all(
      Array.from({ length: 6 }, () =>
        member.post(`/v1/sites/${site.id}/versions`, { spec: salonSpec(), baseVersionId: site.v1 }),
      ),
    );
    expect(saves.map((response) => response.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    const winner = saves.find((response) => response.status === 201)?.body.id;
    for (const lost of saves.filter((response) => response.status === 409))
      expect(lost.body.currentVersionId).toBe(winner);
    const businessId = await track({ displayName: 'Create Race' });
    const creates = await Promise.all(
      Array.from({ length: 6 }, () => member.post('/v1/sites', { businessId })),
    );
    expect(creates.map((response) => response.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect(new Set(creates.map((response) => response.body.id)).size).toBe(1);
  });

  it('keeps versions immutable in the database: no rewrite, no delete but with the site, quality once', async () => {
    const site = await newSite('Immutable');
    const id = site.v1;
    const changes = [
      { changeSummary: 'rewritten' },
      { spec: { schemaVersion: 1 } },
      { specHash: 'a'.repeat(64) },
    ];
    for (const change of changes)
      expect(await dbError(db.update(siteVersions).set(change).where(eq(siteVersions.id, id)))).toMatch(
        /immutable/,
      );
    expect(
      await dbError(
        db.update(siteVersions).set({ quality: sql`'null'::jsonb` }).where(eq(siteVersions.id, id)),
      ),
    ).toMatch(/immutable/);
    await db
      .update(siteVersions)
      .set({ quality: { score: 91 } })
      .where(eq(siteVersions.id, id));
    const [stored] = await db
      .select({ quality: siteVersions.quality })
      .from(siteVersions)
      .where(eq(siteVersions.id, id));
    expect(stored?.quality).toEqual({ score: 91 });
    expect(
      await dbError(
        db
          .update(siteVersions)
          .set({ quality: { score: 10 } })
          .where(eq(siteVersions.id, id)),
      ),
    ).toMatch(/immutable/);
    expect(await dbError(db.delete(siteVersions).where(eq(siteVersions.id, id)))).toMatch(
      /deleted only with their site/,
    );
    // Deleting the site removes everything at once (published too).
    await member.post(`/v1/sites/${site.id}/preview`, { versionId: id }).expect(201);
    await db.delete(sites).where(eq(sites.id, site.id));
    expect(await db.select().from(siteVersions).where(eq(siteVersions.siteId, site.id))).toEqual([]);
    expect(await db.select().from(sitePublications).where(eq(sitePublications.siteId, site.id))).toEqual([]);
  });

  it('pages sites created in the same millisecond exactly once, and refuses a tampered cursor', async () => {
    const ids: string[] = [];
    for (const [i, name] of ['Page A', 'Page B', 'Page C'].entries()) {
      const businessId = await track({ displayName: name });
      const id = (await member.post('/v1/sites', { businessId }).expect(201)).body.id as string;
      ids.push(id);
      await db.execute(
        sql`UPDATE sites SET created_at = '2030-01-01T00:00:00.1231Z'::timestamptz + make_interval(secs => ${i * 0.0002}) WHERE id = ${id}`,
      );
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { body: { items: { id: string }[]; nextCursor: string | null } } = await viewer
        .get(`/v1/sites?limit=1${cursor ? `&cursor=${cursor}` : ''}`)
        .expect(200);
      seen.push(...page.body.items.map((site) => site.id));
      cursor = page.body.nextCursor;
    } while (cursor && seen.length < 100);
    for (const id of ids) expect(seen.filter((seenId) => seenId === id)).toHaveLength(1);
    const forged = await encodeCursor({ sort: ['2026-10-15T08:00:00.000000Z'], id: "x' OR 1=1" });
    await viewer.get(`/v1/sites?cursor=${forged}`).expect(422);
  });
});

describe('authorization', () => {
  it('requires the permission on every write, and hides another workspace’s sites and versions', async () => {
    const site = await newSite('Authorization');
    const other = await newSite('Other Site');
    const writes: [string, Record<string, unknown>][] = [
      ['versions', { spec: salonSpec(), baseVersionId: site.v1 }],
      ['operations', { baseVersionId: site.v1, operations: [{ op: 'setTheme', theme: theme('sm') }] }],
      ['rollback', { versionId: site.v1, baseVersionId: site.v1 }],
      ['preview', { versionId: site.v1 }],
      ['preview/extend', { days: 1 }],
      ['unpublish', { environment: 'preview' }],
      ['archive', {}],
    ];
    for (const [path, body] of writes) {
      await viewer.post(`/v1/sites/${site.id}/${path}`, body).expect(403);
      await outsider.post(`/v1/sites/${site.id}/${path}`, body).expect(404);
    }
    for (const path of ['', '/versions', `/versions/${site.v1}`, `/diff?from=${site.v1}&to=${site.v1}`])
      await outsider.get(`/v1/sites/${site.id}${path}`).expect(404);
    expect((await outsider.get('/v1/sites').expect(200)).body.items).toEqual([]);
    // A version of another site is not this site's.
    await member.post(`/v1/sites/${site.id}/preview`, { versionId: other.v1 }).expect(404);
    await member
      .post(`/v1/sites/${site.id}/rollback`, { versionId: other.v1, baseVersionId: site.v1 })
      .expect(404);
    await viewer.get(`/v1/sites/${site.id}/versions/${other.v1}`).expect(404);
    await viewer.get(`/v1/sites/${site.id}/diff?from=${site.v1}&to=${other.v1}`).expect(404);
  });
});

describe('publications', () => {
  it('publishes a preview the renderer reads, extends it, replaces it and takes it offline (410 data)', async () => {
    const site = await newSite('Publish Test');
    const published = await member
      .post(`/v1/sites/${site.id}/preview`, { versionId: site.v1, expiresInDays: 10 })
      .expect(201);
    expect(published.body).toMatchObject({
      environment: 'preview',
      status: 'active',
      publishedAt: NOW,
      expiresAt: '2026-10-24T12:00:00.000Z',
    });
    const hostname = published.body.hostname as string;
    expect(hostname).toMatch(/^publish-test-gustavia-[a-z2-9]{6}\.sites\.test$/);
    expect(published.body.url).toBe(`https://${hostname}/`);
    expect((await viewer.get(`/v1/sites/${site.id}`).expect(200)).body).toMatchObject({
      status: 'preview',
      preview: { url: `https://${hostname}/`, expiresAt: '2026-10-24T12:00:00.000Z' },
    });

    const renderer = rendererDb();
    const view = () =>
      renderer.execute(
        sql`SELECT hostname, site_id, status, business_name, agency_name, environment, version_id, noindex, preview_banner, spec->>'schemaVersion' AS v FROM renderer_published_sites WHERE hostname = ${hostname}`,
      );
    try {
      expect(await view()).toEqual([
        {
          hostname,
          site_id: site.id,
          status: 'active',
          business_name: 'Publish Test',
          agency_name: 'Agence Sites',
          environment: 'preview',
          version_id: site.v1,
          noindex: true,
          preview_banner: true,
          v: '1',
        },
      ]);
      await member.post(`/v1/sites/${site.id}/preview/extend`, { days: 5 }).expect(200);
      const v2 = await member
        .post(`/v1/sites/${site.id}/operations`, {
          baseVersionId: site.v1,
          operations: [{ op: 'setTheme', theme: theme('lg') }],
        })
        .expect(201);
      const replaced = await member
        .post(`/v1/sites/${site.id}/preview`, { versionId: v2.body.id })
        .expect(201);
      expect(replaced.body.hostname).toBe(hostname);
      const rows = await db.select().from(sitePublications).where(eq(sitePublications.siteId, site.id));
      expect(rows.map((row) => `${row.versionId}:${row.status}`).sort()).toEqual(
        [`${site.v1}:unpublished`, `${v2.body.id}:active`].sort(),
      );
      await member.post(`/v1/sites/${site.id}/unpublish`, { environment: 'preview' }).expect(204);
      await member.post(`/v1/sites/${site.id}/unpublish`, { environment: 'preview' }).expect(409);
      // The host is still known (a 410 page with the agency), without its spec.
      expect(await view()).toEqual([expect.objectContaining({ hostname, status: 'unpublished', v: null })]);
    } finally {
      await closeDb(renderer);
    }
    expect((await viewer.get(`/v1/sites/${site.id}`).expect(200)).body).toMatchObject({
      status: 'draft',
      preview: null,
    });
    expect(await eventsOf(site.id)).toEqual(
      expect.arrayContaining([
        'site.created',
        'site.version.created',
        'site.published',
        'site.preview.extended',
        'site.unpublished',
      ]),
    );
  });

  it('lets the renderer role read its views only: no table, no write even with read-write on', async () => {
    const renderer = rendererDb(false);
    try {
      for (const table of ['sites', 'site_versions', 'site_publications', 'site_assets', 'site_view_daily']) {
        expect(await dbError(renderer.execute(sql.raw(`SELECT 1 FROM ${table} LIMIT 1`)))).toMatch(
          /permission denied/,
        );
      }
      expect(
        await dbError(
          renderer.transaction(async (tx) => {
            await tx.execute(sql`SET TRANSACTION READ WRITE`);
            await tx.execute(sql`UPDATE site_publications SET status = 'unpublished'`);
          }),
        ),
      ).toMatch(/permission denied/);
      const [privileges] = await db.execute(
        sql`SELECT bool_or(has_table_privilege('bf_sites_ro', t, 'INSERT,UPDATE,DELETE')) AS writes
            FROM unnest(ARRAY['renderer_published_sites', 'renderer_site_assets', 'sites', 'site_versions', 'site_publications', 'site_assets']) AS t`,
      );
      expect(privileges).toEqual({ writes: false });
      await renderer.execute(sql`SELECT id, public_url FROM renderer_site_assets LIMIT 1`);
    } finally {
      await closeDb(renderer);
    }
  });

  it('shows the renderer only ready images of active publications, and only an http(s) agency URL', async () => {
    const published = await newSite('Renderer Images');
    const draft = await newSite('Renderer Draft');
    const preview = await member
      .post(`/v1/sites/${published.id}/preview`, { versionId: published.v1 })
      .expect(201);
    const asset = (siteId: string, status: 'ready' | 'pending') => ({
      id: newId(),
      organizationId: org,
      siteId,
      storageKey: `orgs/${org}/sites/${siteId}/assets/${newId()}/original`,
      mime: 'image/jpeg',
      license: 'uploaded' as const,
      status,
      publicUrl: status === 'ready' ? 'https://assets.bf-sites.test/x.webp' : null,
    });
    const ready = asset(published.id, 'ready');
    await db.insert(siteAssets).values([ready, asset(published.id, 'pending'), asset(draft.id, 'ready')]);
    const renderer = rendererDb();
    try {
      const visible = async () =>
        (
          await renderer.execute<{ id: string }>(
            sql`SELECT id FROM renderer_site_assets WHERE site_id IN (${published.id}, ${draft.id})`,
          )
        ).map((row) => row.id);
      expect(await visible()).toEqual([ready.id]);
      const agencyUrl = async () =>
        (
          await renderer.execute<{ agency_url: string | null }>(
            sql`SELECT agency_url FROM renderer_published_sites WHERE hostname = ${preview.body.hostname}`,
          )
        )[0]?.agency_url;
      await db
        .insert(orgSettings)
        .values({ organizationId: org, websiteUrl: 'javascript:alert(1)' })
        .onConflictDoUpdate({
          target: orgSettings.organizationId,
          set: { websiteUrl: 'javascript:alert(1)' },
        });
      expect(await agencyUrl()).toBeNull();
      await db
        .update(orgSettings)
        .set({ websiteUrl: 'https://agency.example' })
        .where(eq(orgSettings.organizationId, org));
      expect(await agencyUrl()).toBe('https://agency.example');
      // Its preview's expiry has passed (before the hourly job ends it): its images are no longer served.
      await db
        .update(sitePublications)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(sitePublications.id, preview.body.id));
      expect(await visible()).toEqual([]);
    } finally {
      await closeDb(renderer);
    }
  });

  it('reads a site request larger than the default JSON limit, and refuses one over the cap early', async () => {
    const site = await newSite('Large Body');
    const large = { spec: { ...salonSpec(), padding: 'x'.repeat(300_000) }, baseVersionId: site.v1 };
    const refused = await member.post(`/v1/sites/${site.id}/versions`, large).expect(422);
    expect(refused.body).toMatchObject({ reason: 'SITE_SPEC_INVALID' });
    const huge = { spec: { ...salonSpec(), padding: 'x'.repeat(900_000) }, baseVersionId: site.v1 };
    await member.post(`/v1/sites/${site.id}/versions`, huge).expect(413);
  });

  it('refuses to publish a stored version the validators now refuse', async () => {
    const site = await newSite('Stale Version');
    const spec = salonSpec();
    (spec.seo as { title: Record<string, string> }).title.en = 'Visit www.evil.example today';
    const bad = newId();
    await db.insert(siteVersions).values({
      id: bad,
      siteId: site.id,
      versionNumber: 2,
      spec,
      specHash: 'b'.repeat(64),
      schemaVersion: 1,
      authorType: 'import',
      validation: { issues: [] },
    });
    const refused = await member.post(`/v1/sites/${site.id}/preview`, { versionId: bad }).expect(422);
    expect(refused.body).toMatchObject({ reason: 'SITE_SPEC_INVALID' });
    expect(await db.select().from(sitePublications).where(eq(sitePublications.siteId, site.id))).toEqual([]);
    expect(await eventsOf(site.id)).not.toContain('site.published');
  });

  it('refuses a second active publication or hostname in the database', async () => {
    const site = await newSite('Unique Host');
    const pub = (await member.post(`/v1/sites/${site.id}/preview`, { versionId: site.v1 }).expect(201)).body;
    const insert = (environment: 'preview' | 'live', hostname: string) =>
      db
        .insert(sitePublications)
        .values({ id: newId(), siteId: site.id, versionId: site.v1, environment, hostname });
    expect(await dbError(insert('preview', 'another.sites.test'))).toMatch(
      /uq_site_publications__active_environment/,
    );
    expect(await dbError(insert('live', pub.hostname))).toMatch(/uq_site_publications__active_hostname/);
  });

  it('expires previews through the hourly job in the worker, once, and the renderer shows them expired', async () => {
    const site = await newSite('Expiring');
    const pub = (
      await member.post(`/v1/sites/${site.id}/preview`, { versionId: site.v1, expiresInDays: 1 }).expect(201)
    ).body;
    await db
      .update(sitePublications)
      .set({ expiresAt: new Date('2026-10-13T00:00:00.000Z') })
      .where(eq(sitePublications.id, pub.id));
    // Past its expiry, the renderer already treats it as expired, before the job runs.
    const [before] = await db.execute(
      sql`SELECT status, spec FROM renderer_published_sites WHERE hostname = ${pub.hostname}`,
    );
    expect(before).toEqual({ status: 'expired', spec: null });
    const scheduler = worker.get(SitesExpiryScheduler);
    await scheduler.tick();
    await scheduler.tick();
    await expect
      .poll(
        async () =>
          (await db.select().from(sitePublications).where(eq(sitePublications.id, pub.id)))[0]?.status,
        { timeout: 20_000, interval: 100 },
      )
      .toBe('expired');
    const expireQueue = worker.get<Queue>(getQueueToken(QUEUES.sitesExpire.name));
    expect(await expireQueue.getJobs(['completed', 'active', 'waiting', 'delayed'])).toHaveLength(1);
    const [row] = await db.select().from(sitePublications).where(eq(sitePublications.id, pub.id));
    expect(row?.endedAt).toBeInstanceOf(Date);
    expect((await viewer.get(`/v1/sites/${site.id}`).expect(200)).body.status).toBe('draft');
    expect((await eventsOf(site.id)).filter((type) => type === 'site.expired')).toHaveLength(1);
    // The outbox subscriber asks the renderer to refresh that host.
    const revalidate = worker.get<Queue>(getQueueToken(QUEUES.sitesRevalidate.name));
    await expect
      .poll(
        async () =>
          (await revalidate.getJobs(['completed', 'active', 'waiting', 'delayed', 'failed'])).some((job) =>
            (job.data.tags as string[] | undefined)?.includes(`host:${pub.hostname}`),
          ),
        { timeout: 20_000, interval: 100 },
      )
      .toBe(true);
  });

  it('rolls back as a new version and archives (offline, no further change)', async () => {
    const businessId = await track({ displayName: 'Rollback' });
    const created = (await member.post('/v1/sites', { businessId, spec: salonSpec() }).expect(201)).body;
    const site = { id: created.id as string, v1: created.currentVersion.id as string };
    const v2 = (
      await member
        .post(`/v1/sites/${site.id}/operations`, {
          baseVersionId: site.v1,
          operations: [{ op: 'setTheme', theme: theme('none') }],
        })
        .expect(201)
    ).body;
    const back = await member
      .post(`/v1/sites/${site.id}/rollback`, { versionId: site.v1, baseVersionId: v2.id })
      .expect(201);
    expect(back.body).toMatchObject({
      versionNumber: 3,
      authorType: 'rollback',
      changeSummary: 'Rollback to version 1',
    });
    const hashes = await db
      .select({ id: siteVersions.id, hash: siteVersions.specHash })
      .from(siteVersions)
      .where(eq(siteVersions.siteId, site.id));
    const hashOf = (id: string) => hashes.find((row) => row.id === id)?.hash;
    expect(hashOf(back.body.id)).toBe(hashOf(site.v1));

    const pub = (await member.post(`/v1/sites/${site.id}/preview`, { versionId: back.body.id }).expect(201))
      .body;
    await member.post(`/v1/sites/${site.id}/archive`, {}).expect(204);
    expect((await viewer.get(`/v1/sites/${site.id}`).expect(200)).body).toMatchObject({
      status: 'archived',
      publications: [],
    });
    const [shown] = await db.execute(
      sql`SELECT status FROM renderer_published_sites WHERE hostname = ${pub.hostname}`,
    );
    expect(shown).toEqual({ status: 'unpublished' });
    const archivedPublish = await member
      .post(`/v1/sites/${site.id}/preview`, { versionId: back.body.id })
      .expect(409);
    expect(archivedPublish.body).toMatchObject({ reason: 'SITE_ARCHIVED' });
    await member
      .post(`/v1/sites/${site.id}/versions`, { spec: salonSpec(), baseVersionId: back.body.id })
      .expect(409);
    expect((await eventsOf(site.id)).filter((type) => type === 'site.archived')).toHaveLength(1);
    // An archived site no longer counts as the business's site: a new one can be made.
    const fresh = await member.post('/v1/sites', { businessId }).expect(201);
    expect(fresh.body.id).not.toBe(site.id);
    const [stored] = await db.select({ status: sites.status }).from(sites).where(eq(sites.id, site.id));
    expect(stored?.status).toBe('archived');
  });
});
