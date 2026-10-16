import type { DbClient } from '@bf/db';
import {
  businessContacts,
  businesses,
  businessHours,
  factRegistrySnapshots,
  orgBusinesses,
  orgBusinessFacts,
  websiteSnapshots,
} from '@bf/db/schema';
import { aBusiness, aContact } from '@bf/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import {
  type Browser,
  createWorkspace,
  inviteAndJoin,
  signUpVerified,
} from '../../../test/identity-helpers.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';
import { FactRegistryService } from './application/facts.service.ts';

// The fact registry (BF-040) on a real database: global facts from the graph and the latest crawl with their usage,
// the workspace overlay through the API, authz, and deduplicated snapshots.

const mailer = new FakeMailer();
let t: TestApp;
let db: DbClient;
let member: Browser;
let viewer: Browser;
let outsider: Browser;
let org: string;
let businessId: string;

type Fact = { kind: string; value: unknown; source: string; usage: string; id: string };

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 23 });
  db = t.app.get(DB_CLIENT);
  member = await signUpVerified(t, mailer, 'member@facts.test', 'Fanny Facts');
  org = await createWorkspace(member, 'Agence Faits');
  viewer = (await inviteAndJoin(t, mailer, member, 'viewer@facts.test', 'viewer')).client;
  outsider = await signUpVerified(t, mailer, 'outsider@facts.test', 'Otto Outsider');
  await createWorkspace(outsider, 'Ailleurs');

  const business = aBusiness({
    displayName: 'Café Gustavia',
    locality: 'Gustavia',
    websiteUrl: 'https://cafe-gustavia.example/',
  });
  businessId = business.id;
  await db.insert(businesses).values({
    ...business,
    attributes: {
      displayName: {
        value: 'Café Gustavia',
        source: 'osm',
        sourceRef: 'node/42',
        confidence: 0.9,
        observedAt: '2026-10-01T10:00:00.000Z',
      },
    },
  });
  await db.insert(orgBusinesses).values({ organizationId: org, businessId, addedVia: 'search' });
  await db.insert(businessContacts).values([
    aContact({
      businessId,
      type: 'phone',
      value: '+590590270001',
      source: 'google_places',
      publishedOnSite: false,
    }),
    aContact({
      businessId,
      type: 'email',
      value: 'Bonjour@Cafe-Gustavia.example',
      sourceUrl: 'https://cafe-gustavia.example/contact',
    }),
  ]);
  await db.insert(businessHours).values([
    { businessId, weekday: 0, opensAt: '08:00', closesAt: '15:00', source: 'osm' },
    { businessId, weekday: 5, opensAt: '08:00', closesAt: '13:00', source: 'osm' },
  ]);
  const empty = {} as never;
  await db.insert(websiteSnapshots).values({
    businessId,
    url: 'https://cafe-gustavia.example/',
    fetchedAt: new Date('2026-10-10T09:00:00Z'),
    reachability: 'ok',
    tls: empty,
    security: empty,
    languages: empty,
    pages: [],
    contacts: empty,
    socials: [
      { network: 'instagram', url: 'https://www.instagram.com/cafegustavia/', handle: 'cafegustavia' },
    ],
    booking: empty,
    ordering: empty,
    chat: empty,
    analytics: empty,
    tech: [],
    freshness: empty,
    mobile: empty,
    performanceHints: empty,
    links: empty,
    noSolicitation: empty,
    logoCandidates: [
      { url: 'https://cafe-gustavia.example/favicon.ico', source: 'link-icon', width: 32, height: 32 },
      { url: 'https://cafe-gustavia.example/logo.png', source: 'img-logo', width: 400, height: 160 },
    ],
    imageCandidates: [],
    warnings: [],
    contentHash: 'test',
  });
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('fact registry (BF-040)', () => {
  it('lists the global facts with their provenance and usage', async () => {
    const { body } = await viewer.get(`/v1/businesses/${businessId}/facts`).expect(200);
    const facts = body.facts as Fact[];
    const byKind = (kind: string) => facts.filter((fact) => fact.kind === kind);
    expect(byKind('name')[0]).toMatchObject({
      value: 'Café Gustavia',
      source: 'open_data',
      usage: 'display',
    });
    expect(byKind('phone')[0]).toMatchObject({ source: 'provider_restricted', usage: 'internal' });
    expect(byKind('email')[0]).toMatchObject({
      value: 'bonjour@cafe-gustavia.example',
      source: 'owner_site',
      usage: 'display',
    });
    expect(byKind('hours')[0]).toMatchObject({
      value: {
        weekly: [
          { day: 'mon', opens: '08:00', closes: '15:00' },
          { day: 'sat', opens: '08:00', closes: '13:00' },
        ],
      },
      usage: 'display',
    });
    expect(byKind('social')[0]).toMatchObject({ value: { network: 'instagram' }, source: 'owner_site' });
    expect(byKind('logo')[0]).toMatchObject({ value: 'https://cafe-gustavia.example/logo.png' });
    expect(body.overlay).toEqual([]);
    expect(body.stats.internal).toBeGreaterThanOrEqual(1);
  });

  it('keeps the workspace’s own facts in its overlay, without changing the global graph', async () => {
    const { body: created } = await member
      .post(`/v1/businesses/${businessId}/facts`, { kind: 'name', value: 'Le Café Gustavia', locale: 'fr' })
      .expect(201);
    expect(created).toMatchObject({ kind: 'name', value: 'Le Café Gustavia', locale: 'fr', note: null });

    const { body } = await member.get(`/v1/businesses/${businessId}/facts`).expect(200);
    const names = (body.facts as Fact[]).filter((fact) => fact.kind === 'name');
    expect(names.map((fact) => [fact.value, fact.source, fact.usage])).toEqual(
      expect.arrayContaining([
        ['Café Gustavia', 'open_data', 'internal'],
        ['Le Café Gustavia', 'user', 'display'],
      ]),
    );
    const [row] = await db
      .select({ name: businesses.displayName })
      .from(businesses)
      .where(eq(businesses.id, businessId));
    expect(row?.name).toBe('Café Gustavia');

    const { body: updated } = await member
      .patch(`/v1/businesses/${businessId}/facts/${created.id}`, {
        value: 'Café de Gustavia',
        note: 'From the owner',
      })
      .expect(200);
    expect(updated).toMatchObject({ value: 'Café de Gustavia', note: 'From the owner' });

    await member.delete(`/v1/businesses/${businessId}/facts/${created.id}`).expect(204);
    await member.delete(`/v1/businesses/${businessId}/facts/${created.id}`).expect(404);
    const [deleted] = await db.select().from(orgBusinessFacts).where(eq(orgBusinessFacts.id, created.id));
    expect(deleted?.deletedAt).not.toBeNull();
  });

  it('rejects values that do not fit their kind', async () => {
    const response = await member
      .post(`/v1/businesses/${businessId}/facts`, { kind: 'brand_color', value: 'blue' })
      .expect(422);
    expect(response.headers['content-type']).toContain('application/problem+json');
    await member.post(`/v1/businesses/${businessId}/facts`, { kind: 'unknown_kind', value: 'x' }).expect(422);
  });

  it('enforces permissions and workspaces', async () => {
    await viewer.post(`/v1/businesses/${businessId}/facts`, { kind: 'service', value: 'Brunch' }).expect(403);
    await outsider.get(`/v1/businesses/${businessId}/facts`).expect(404);
    await outsider
      .post(`/v1/businesses/${businessId}/facts`, { kind: 'service', value: 'Brunch' })
      .expect(404);
    const { body } = await member
      .post(`/v1/businesses/${businessId}/facts`, { kind: 'service', value: 'Brunch' })
      .expect(201);
    await outsider.patch(`/v1/businesses/${businessId}/facts/${body.id}`, { value: 'x' }).expect(404);
    await outsider.delete(`/v1/businesses/${businessId}/facts/${body.id}`).expect(404);
  });

  it('stores snapshots once per content', async () => {
    const service = t.app.get(FactRegistryService);
    const first = await service.snapshot(org, businessId);
    const again = await service.snapshot(org, businessId);
    expect(again.id).toBe(first.id);
    const rows = await db
      .select()
      .from(factRegistrySnapshots)
      .where(eq(factRegistrySnapshots.businessId, businessId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.facts).toEqual(first.facts);
  });
});
