import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { closeDb, createDb, type DbClient } from '@bf/db';
import {
  businesses,
  orgBusinesses,
  outboxEvents,
  sitePublications,
  sites,
  siteVersions,
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
import { DB_CLIENT } from '../platform/db/db.module.ts';
import { SiteCommands } from './index.ts';

// Sites (BF-035) end to end: roles and workspaces, versions with optimistic concurrency and immutability in the
// database, publications, the renderer's read-only view, expiry, rollback, archive and diffs.

const fixtures = join(
  dirname(createRequire(import.meta.url).resolve('@bf/site-schema/package.json')),
  'fixtures',
);
const salonSpec = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(fixtures, 'salon-gustavia.json'), 'utf8'));

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

/** A connection as the renderer's read-only role, to the test database. */
function rendererDb(): DbClient {
  const url = new URL(t.env.DATABASE_URL);
  url.username = 'bf_sites_ro';
  url.password = 'bf_sites_ro_test_only';
  return createDb({ url: url.href, readOnly: true });
}

beforeAll(async () => {
  t = await createTestApp({
    mailer,
    valkeyDb: 20,
    env: { SITES_BASE_DOMAIN: 'sites.test', SITES_ASSETS_BASE_URL: 'https://assets.bf-sites.test' },
  });
  db = t.app.get(DB_CLIENT);
  worker = await createTestWorker(t, {
    mailer,
    env: { SITES_BASE_DOMAIN: 'sites.test', SITES_ASSETS_BASE_URL: 'https://assets.bf-sites.test' },
  });
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
  it('creates a business’s site once (idempotent), with a slug from its name and locality', async () => {
    const businessId = await track();
    const created = await member.post('/v1/sites', { businessId, spec: salonSpec() }).expect(201);
    expect(created.body).toMatchObject({
      businessId,
      businessName: 'Salon Lumière',
      slug: 'salon-lumiere-gustavia',
      status: 'draft',
      currentVersion: { versionNumber: 1 },
      currentVersionSummary: { authorType: 'user', changeSummary: 'First version' },
      publications: [],
    });
    const again = await member.post('/v1/sites', { businessId }).expect(200);
    expect(again.body.id).toBe(created.body.id);
    const other = await member.post('/v1/sites', { businessId, forceNew: true }).expect(201);
    expect(other.body).toMatchObject({ slug: 'salon-lumiere-gustavia-2', currentVersion: null });
  });

  it('checks roles and workspaces: a viewer reads, an outsider sees nothing', async () => {
    const businessId = await track({ displayName: 'Viewer Test' });
    await viewer.post('/v1/sites', { businessId }).expect(403);
    const { body } = await member.post('/v1/sites', { businessId }).expect(201);
    await viewer.get(`/v1/sites/${body.id}`).expect(200);
    await viewer.post(`/v1/sites/${body.id}/archive`, {}).expect(403);
    await outsider.get(`/v1/sites/${body.id}`).expect(404);
    await outsider.post('/v1/sites', { businessId }).expect(404);
    const listed = await outsider.get('/v1/sites').expect(200);
    expect(listed.body.items).toEqual([]);
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

  it('saves versions only from the current one (409 with the current id), and applies operations atomically', async () => {
    const businessId = await track({ displayName: 'Concurrency' });
    const site = (await member.post('/v1/sites', { businessId, spec: salonSpec() }).expect(201)).body;
    const v1 = site.currentVersion.id as string;
    const v2 = await member
      .post(`/v1/sites/${site.id}/versions`, {
        spec: salonSpec(),
        baseVersionId: v1,
        changeSummary: 'Same again',
      })
      .expect(201);
    expect(v2.body).toMatchObject({ versionNumber: 2, parentVersionId: v1, changeSummary: 'Same again' });
    // An edit started from v1 loses the race: a conflict with the current version, nothing written.
    const stale = await member
      .post(`/v1/sites/${site.id}/versions`, { spec: salonSpec(), baseVersionId: v1 })
      .expect(409);
    expect(stale.body).toMatchObject({ code: 'SITE_VERSION_CONFLICT', currentVersionId: v2.body.id });
    // Operations: a new version with an automatic summary; a refused operation writes nothing.
    const v3 = await member
      .post(`/v1/sites/${site.id}/operations`, {
        baseVersionId: v2.body.id,
        operations: [{ op: 'setTheme', theme: { ...(salonSpec().theme as object), radius: 'full' } }],
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

  it('keeps versions immutable in the database (only the quality report is set, once)', async () => {
    const businessId = await track({ displayName: 'Immutable' });
    const site = (await member.post('/v1/sites', { businessId, spec: salonSpec() }).expect(201)).body;
    const id = site.currentVersion.id as string;
    expect(
      await dbError(
        db.update(siteVersions).set({ changeSummary: 'rewritten' }).where(eq(siteVersions.id, id)),
      ),
    ).toMatch(/immutable/);
    await db
      .update(siteVersions)
      .set({ quality: { score: 91 } })
      .where(eq(siteVersions.id, id));
    expect(
      await dbError(
        db
          .update(siteVersions)
          .set({ quality: { score: 10 } })
          .where(eq(siteVersions.id, id)),
      ),
    ).toMatch(/immutable/);
    expect(
      await dbError(
        db.update(siteVersions).set({ quality: null, changeSummary: 'x' }).where(eq(siteVersions.id, id)),
      ),
    ).toMatch(/immutable/);
  });
});

describe('publications', () => {
  it('publishes a preview the renderer reads (read-only), extends it, replaces it and takes it offline', async () => {
    const businessId = await track({ displayName: 'Publish Test', locality: 'Lorient' });
    const site = (await member.post('/v1/sites', { businessId, spec: salonSpec() }).expect(201)).body;
    const v1 = site.currentVersion.id as string;
    await viewer.post(`/v1/sites/${site.id}/preview`, { versionId: v1 }).expect(403);
    const published = await member
      .post(`/v1/sites/${site.id}/preview`, { versionId: v1, expiresInDays: 10 })
      .expect(201);
    expect(published.body).toMatchObject({
      environment: 'preview',
      hostname: 'publish-test-lorient.sites.test',
      url: 'https://publish-test-lorient.sites.test/',
      status: 'active',
      publishedAt: '2026-10-14T12:00:00.000Z',
      expiresAt: '2026-10-24T12:00:00.000Z',
    });
    expect((await viewer.get(`/v1/sites/${site.id}`).expect(200)).body).toMatchObject({
      status: 'preview',
      preview: { url: 'https://publish-test-lorient.sites.test/', expiresAt: '2026-10-24T12:00:00.000Z' },
    });

    const renderer = rendererDb();
    try {
      const rows = await renderer.execute(
        sql`SELECT hostname, site_id, business_name, agency_name, environment, version_id, noindex, spec->>'schemaVersion' AS v FROM renderer_published_sites WHERE hostname = 'publish-test-lorient.sites.test'`,
      );
      expect(rows).toEqual([
        {
          hostname: 'publish-test-lorient.sites.test',
          site_id: site.id,
          business_name: 'Publish Test',
          agency_name: 'Agence Sites',
          environment: 'preview',
          version_id: v1,
          noindex: true,
          v: '1',
        },
      ]);
      // The renderer reads only its view: no table, no write.
      expect(await dbError(renderer.execute(sql`SELECT count(*) FROM sites`))).toMatch(/permission denied/);
      expect(
        await dbError(renderer.execute(sql`UPDATE site_publications SET status = 'unpublished'`)),
      ).toMatch(/read-only|permission denied/);
    } finally {
      await closeDb(renderer);
    }

    const extended = await member.post(`/v1/sites/${site.id}/preview/extend`, { days: 5 }).expect(200);
    expect(extended.body.expiresAt).toBe('2026-10-29T12:00:00.000Z');
    // A new preview replaces the active one (one active per environment, the hostname moves to the new row).
    const v2 = await member
      .post(`/v1/sites/${site.id}/operations`, {
        baseVersionId: v1,
        operations: [{ op: 'setTheme', theme: { ...(salonSpec().theme as object), radius: 'lg' } }],
      })
      .expect(201);
    const replaced = await member.post(`/v1/sites/${site.id}/preview`, { versionId: v2.body.id }).expect(201);
    const rows = await db.select().from(sitePublications).where(eq(sitePublications.siteId, site.id));
    expect(rows.map((row) => [row.versionId, row.status])).toEqual(
      expect.arrayContaining([
        [v1, 'unpublished'],
        [v2.body.id, 'active'],
      ]),
    );
    expect(replaced.body.expiresAt).toBe('2026-11-13T12:00:00.000Z');

    await member.post(`/v1/sites/${site.id}/unpublish`, { environment: 'preview' }).expect(204);
    await member.post(`/v1/sites/${site.id}/unpublish`, { environment: 'preview' }).expect(409);
    expect((await viewer.get(`/v1/sites/${site.id}`).expect(200)).body).toMatchObject({
      status: 'draft',
      preview: null,
    });
    const events = await db
      .select({ type: outboxEvents.type })
      .from(outboxEvents)
      .where(sql`${outboxEvents.payload}->>'siteId' = ${site.id}`);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['site.created', 'site.version.created', 'site.published', 'site.unpublished']),
    );
  });

  it('refuses a second active publication or hostname in the database', async () => {
    const businessId = await track({ displayName: 'Unique Host' });
    const site = (await member.post('/v1/sites', { businessId, spec: salonSpec() }).expect(201)).body;
    const pub = (
      await member.post(`/v1/sites/${site.id}/preview`, { versionId: site.currentVersion.id }).expect(201)
    ).body;
    expect(
      await dbError(
        db.insert(sitePublications).values({
          id: crypto.randomUUID(),
          siteId: site.id,
          versionId: site.currentVersion.id,
          environment: 'preview',
          hostname: 'another.sites.test',
        }),
      ),
    ).toMatch(/uq_site_publications__active_environment/);
    expect(
      await dbError(
        db.insert(sitePublications).values({
          id: crypto.randomUUID(),
          siteId: site.id,
          versionId: site.currentVersion.id,
          environment: 'live',
          hostname: pub.hostname,
        }),
      ),
    ).toMatch(/uq_site_publications__active_hostname/);
  });

  it('expires previews past their date (the hourly job), and the renderer no longer serves them', async () => {
    const businessId = await track({ displayName: 'Expiring' });
    const site = (await member.post('/v1/sites', { businessId, spec: salonSpec() }).expect(201)).body;
    const pub = (
      await member
        .post(`/v1/sites/${site.id}/preview`, { versionId: site.currentVersion.id, expiresInDays: 1 })
        .expect(201)
    ).body;
    await db
      .update(sitePublications)
      .set({ expiresAt: new Date('2026-10-13T00:00:00.000Z') })
      .where(eq(sitePublications.id, pub.id));
    expect(await t.app.get(SiteCommands).expireDuePreviews()).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(sitePublications).where(eq(sitePublications.id, pub.id));
    expect(row).toMatchObject({ status: 'expired', endedAt: new Date('2026-10-14T12:00:00.000Z') });
    expect((await viewer.get(`/v1/sites/${site.id}`).expect(200)).body.status).toBe('draft');
    const [view] = await db.execute(
      sql`SELECT count(*)::int AS n FROM renderer_published_sites WHERE site_id = ${site.id}`,
    );
    expect(view).toEqual({ n: 0 });
    const [event] = await db
      .select({ type: outboxEvents.type })
      .from(outboxEvents)
      .where(
        and(eq(outboxEvents.type, 'site.expired'), sql`${outboxEvents.payload}->>'siteId' = ${site.id}`),
      );
    expect(event).toBeDefined();
  });

  it('rolls back as a new version and archives (offline, no further change)', async () => {
    const businessId = await track({ displayName: 'Rollback' });
    const site = (await member.post('/v1/sites', { businessId, spec: salonSpec() }).expect(201)).body;
    const v1 = site.currentVersion.id as string;
    const v2 = (
      await member
        .post(`/v1/sites/${site.id}/operations`, {
          baseVersionId: v1,
          operations: [{ op: 'setTheme', theme: { ...(salonSpec().theme as object), radius: 'none' } }],
        })
        .expect(201)
    ).body;
    const back = await member
      .post(`/v1/sites/${site.id}/rollback`, { versionId: v1, baseVersionId: v2.id })
      .expect(201);
    expect(back.body).toMatchObject({
      versionNumber: 3,
      authorType: 'rollback',
      changeSummary: 'Rollback to version 1',
    });
    const [first, third] = await Promise.all(
      [v1, back.body.id].map(
        async (id) => (await db.select().from(siteVersions).where(eq(siteVersions.id, id)))[0],
      ),
    );
    expect(third?.specHash).toBe(first?.specHash);

    await member.post(`/v1/sites/${site.id}/preview`, { versionId: back.body.id }).expect(201);
    await member.post(`/v1/sites/${site.id}/archive`, {}).expect(204);
    const archived = (await viewer.get(`/v1/sites/${site.id}`).expect(200)).body;
    expect(archived).toMatchObject({ status: 'archived', publications: [] });
    await member.post(`/v1/sites/${site.id}/preview`, { versionId: back.body.id }).expect(409);
    await member
      .post(`/v1/sites/${site.id}/versions`, { spec: salonSpec(), baseVersionId: back.body.id })
      .expect(409);
    // An archived site no longer counts as the business's site: a new one can be made.
    const fresh = await member.post('/v1/sites', { businessId }).expect(201);
    expect(fresh.body.id).not.toBe(site.id);
    const [stored] = await db.select({ status: sites.status }).from(sites).where(eq(sites.id, site.id));
    expect(stored?.status).toBe('archived');
  });
});
