import { type DbClient, runInTransaction } from '@bf/db';
import { categories, categoryMappings, providerUsage } from '@bf/db/schema';
import { loadTaxonomy, seedTaxonomy } from '@bf/db/seed';
import { and, eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import {
  type Browser,
  createWorkspace,
  inviteAndJoin,
  signUpVerified,
} from '../../../test/identity-helpers.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';
import { VALKEY } from '../platform/valkey/valkey.module.ts';
import { ProviderQueryBuilder } from './application/discovery.services.ts';
import { PROVIDER_USAGE_METER, type ProviderUsageMeter } from './application/ports.ts';
import { ProviderRegistry } from './application/provider-registry.ts';
import { DrizzleCategoryProviderKeys } from './infrastructure/drizzle-category-provider-keys.ts';
import { ValkeyRateLimiter } from './infrastructure/valkey-rate-limiter.ts';

const mailer = new FakeMailer();
let t: TestApp;
let db: DbClient;
let owner: Browser;
let member: Browser;
let viewer: Browser;
let orgId: string;
let otherOrgId: string;

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 0 });
  db = t.app.get(DB_CLIENT);
  await runInTransaction(db, (tx) => seedTaxonomy(tx, loadTaxonomy()));
  owner = await signUpVerified(t, mailer, 'owner@discovery.test', 'Olive Owner');
  orgId = await createWorkspace(owner, 'Agence Découverte');
  member = (await inviteAndJoin(t, mailer, owner, 'member@discovery.test', 'member')).client;
  viewer = (await inviteAndJoin(t, mailer, owner, 'viewer@discovery.test', 'viewer')).client;
  const other = await signUpVerified(t, mailer, 'other@discovery.test', 'Other Owner');
  otherOrgId = await createWorkspace(other, 'Autre');
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await t?.close();
});

describe('usage meter', () => {
  const price = { perThousandUsd: 32, freeMonthlyCalls: 3 };
  const at = new Date('2026-03-15T10:00:00Z');

  it('aggregates per day/provider/SKU and charges beyond the free allowance per billing account', async () => {
    const meter = t.app.get<ProviderUsageMeter>(PROVIDER_USAGE_METER);
    const event = { provider: 'google_places', sku: 'text_search_pro', calls: 1, results: 20, at } as const;
    // Two workspaces on the shared deployment key share its free allowance (3 calls).
    expect(await meter.record({ ...event, organizationId: orgId, billingScope: 'global' }, price)).toBe(0);
    expect(await meter.record({ ...event, organizationId: orgId, billingScope: 'global' }, price)).toBe(0);
    expect(await meter.record({ ...event, organizationId: otherOrgId, billingScope: 'global' }, price)).toBe(
      0,
    );
    expect(await meter.record({ ...event, organizationId: orgId, billingScope: 'global' }, price)).toBe(
      0.032,
    );
    // A workspace's own key has its own allowance.
    expect(
      await meter.record({ ...event, organizationId: otherOrgId, billingScope: otherOrgId }, price),
    ).toBe(0);
    // A new month starts a new allowance.
    const april = new Date('2026-04-01T00:00:00Z');
    expect(
      await meter.record({ ...event, organizationId: orgId, billingScope: 'global', at: april }, price),
    ).toBe(0);

    expect(await meter.report(orgId, '2026-03-01', '2026-03-31')).toEqual([
      {
        day: '2026-03-15',
        provider: 'google_places',
        sku: 'text_search_pro',
        calls: 3,
        results: 60,
        costUsd: 0.032,
      },
    ]);
    expect(await meter.monthCostUsd(orgId, at)).toBe(0.032);
    expect((await meter.monthCalls('global', 'google_places', at)).get('text_search_pro')).toBe(4);
  });

  it('serves the usage report to settings managers only', async () => {
    const report = await owner.get('/v1/discovery/usage?from=2026-03-01&to=2026-03-31').expect(200);
    expect(report.body).toMatchObject({ totals: { calls: 3, results: 60, costUsd: 0.032 } });
    await member.get('/v1/discovery/usage?from=2026-03-01&to=2026-03-31').expect(403);
    await owner.get('/v1/discovery/usage?from=2026-03-31&to=2026-03-01').expect(422);
  });
});

describe('rate limiter', () => {
  it('lets a burst through up to capacity, then refills over (fake) time', async () => {
    let now = Date.parse('2026-10-15T12:00:00Z');
    const limiter = new ValkeyRateLimiter(t.app.get<Redis>(VALKEY), { now: () => new Date(now) }, true);
    const key = `test:${crypto.randomUUID()}`;
    const limit = { capacity: 3, perSecond: 2 };
    const burst = [];
    for (let i = 0; i < 4; i++) burst.push(await limiter.tryTake(key, limit));
    expect(burst.slice(0, 3)).toEqual([0, 0, 0]);
    expect(burst[3]).toBe(500);
    now += 500;
    expect(await limiter.tryTake(key, limit)).toBe(0);
    expect(await limiter.tryTake(key, limit)).toBeGreaterThan(0);
    now += 10_000;
    for (let i = 0; i < 3; i++) expect(await limiter.tryTake(key, limit)).toBe(0);
  });
});

describe('category keys', () => {
  it('maps a category (and its descendants) to provider keys from active mappings', async () => {
    const [cafe] = await db
      .select({ id: categories.id, path: categories.path })
      .from(categories)
      .innerJoin(categoryMappings, eq(categoryMappings.categoryId, categories.id))
      .where(and(eq(categoryMappings.provider, 'google_places'), eq(categoryMappings.providerKey, 'cafe')));
    expect(cafe).toBeDefined();
    const [root] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(sql`${categories.path} = subpath(${cafe?.path}::ltree, 0, 1)`);
    const keys = await new DrizzleCategoryProviderKeys(db).keysFor(
      [cafe?.id as string, root?.id as string],
      'google_places',
    );
    expect(keys.get(cafe?.id as string)?.map((k) => k.key)).toContain('cafe');
    // The root category asks for every descendant's keys, without duplicates.
    const rootKeys = keys.get(root?.id as string)?.map((k) => k.key) ?? [];
    expect(rootKeys).toContain('cafe');
    expect(rootKeys.length).toBeGreaterThan(keys.get(cafe?.id as string)?.length ?? 0);
    expect(new Set(rootKeys).size).toBe(rootKeys.length);
  });
});

describe('providers', () => {
  it('lists providers with their status for the workspace', async () => {
    await viewer.get('/v1/discovery/providers').expect(403);
    const listed = await member.get('/v1/discovery/providers').expect(200);
    const byId = Object.fromEntries(listed.body.items.map((p: { id: string }) => [p.id, p]));
    expect(byId.google_places).toMatchObject({
      status: 'not_configured',
      secretName: 'google_places',
      licensing: { retentionDays: 30, attributionText: 'Google Maps' },
    });
    expect(byId.google_places.costModel.skus).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sku: 'text_search_pro', perThousandUsd: 32, freeMonthlyCalls: 5000 }),
      ]),
    );
    expect(byId.fake).toMatchObject({ status: 'ready', secretName: null });
    expect(listed.body.items[0].preferenceRank).toBeLessThanOrEqual(listed.body.items.at(-1).preferenceRank);
  });

  it('follows the workspace discovery settings', async () => {
    const saved = await owner
      .patch('/v1/workspace/settings', {
        discovery: { disabledProviders: ['fake'], googleFieldTier: 'enterprise' },
      })
      .expect(200);
    expect(saved.body.discovery).toMatchObject({
      disabledProviders: ['fake'],
      googleFieldTier: 'enterprise',
      monthlyBudgetUsd: null,
    });
    expect(saved.body.discovery.providerOrder[0]).toBe('overture');
    const listed = await member.get('/v1/discovery/providers').expect(200);
    expect(listed.body.items.find((p: { id: string }) => p.id === 'fake')).toMatchObject({
      status: 'disabled',
    });
    // Sending one field keeps the others.
    const tier = await owner
      .patch('/v1/workspace/settings', { discovery: { disabledProviders: [] } })
      .expect(200);
    expect(tier.body.discovery.googleFieldTier).toBe('enterprise');
  });

  it('fetches fixture records through the decorated provider and meters the call', async () => {
    const [restaurant] = await db
      .select({ id: categoryMappings.categoryId })
      .from(categoryMappings)
      .where(
        and(eq(categoryMappings.provider, 'google_places'), eq(categoryMappings.providerKey, 'restaurant')),
      );
    const queries = await t.app
      .get(ProviderQueryBuilder)
      .build(
        orgId,
        'fake',
        { categoryIds: [restaurant?.id as string], languageCode: 'fr' },
        { type: 'BBox', bbox: { west: -62.9, south: 17.85, east: -62.78, north: 17.95 } },
      );
    expect(queries).toHaveLength(1);
    const provider = t.app.get(ProviderRegistry).get('fake');
    const page = await provider?.fetchPage(queries[0] as never, {
      organizationId: orgId,
      credential: null,
      signal: AbortSignal.timeout(5_000),
    });
    expect(page?.records.map((r) => r.name).sort()).toEqual([
      'Pizzeria Imaginaire',
      'Restaurant Fictif La Plage',
      'Restaurant Test Gouverneur',
    ]);
    expect(page?.callCostUsd).toBe(0);
    const [usage] = await db
      .select()
      .from(providerUsage)
      .where(and(eq(providerUsage.organizationId, orgId), eq(providerUsage.provider, 'fake')));
    expect(usage).toMatchObject({ sku: 'fixture', calls: 1, results: 3, billingScope: 'global' });
  });
});

describe('Google key connection test', () => {
  const GOOGLE_KEY = `AIza${'x'.repeat(35)}`;

  it('runs a free IDs-only search with the stored key and reports a rejected key helpfully', async () => {
    await owner.put('/v1/workspace/secrets/google_places', { value: GOOGLE_KEY }).expect(200);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ places: [{ id: 'fake-place' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const ok = await owner.post('/v1/workspace/secrets/google_places/test').expect(200);
    expect(ok.body).toMatchObject({ ok: true, source: 'workspace' });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(new Headers(init?.headers).get('x-goog-fieldmask')).toBe('places.id,nextPageToken');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: { code: 403, status: 'PERMISSION_DENIED' } }, { status: 403 }),
      ),
    );
    const denied = await owner.post('/v1/workspace/secrets/google_places/test').expect(200);
    expect(denied.body).toMatchObject({ ok: false });
    expect(denied.body.message).toMatch(/rejected/);
    expect(JSON.stringify(denied.body)).not.toContain(GOOGLE_KEY);
    vi.unstubAllGlobals();

    const listed = await member.get('/v1/discovery/providers').expect(200);
    expect(listed.body.items.find((p: { id: string }) => p.id === 'google_places')).toMatchObject({
      status: 'ready',
    });
  });
});
