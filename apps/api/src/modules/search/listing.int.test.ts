import type { AiGateway } from '@bf/ai';
import { fakeEmbedding } from '@bf/ai/testing';
import { type DbClient, runInTransaction } from '@bf/db';
import { businessCategories, businessContacts, businesses, orgBusinesses } from '@bf/db/schema';
import { loadTaxonomy, seedTaxonomy } from '@bf/db/seed';
import { aBusiness, aContact, type BusinessFixture } from '@bf/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../test/create-test-app.ts';
import { FakeMailer } from '../../../test/fake-mailer.ts';
import { type Browser, createWorkspace, signUpVerified } from '../../../test/identity-helpers.ts';
import { GEO_PACKS, importPack } from '../geo/application/packs/index.ts';
import { DrizzleGeoAreaRepository } from '../geo/infrastructure/drizzle-geo-area.repository.ts';
import { AI_GATEWAY } from '../platform/ai/ai.module.ts';
import { APP_ENV } from '../platform/config/app-env.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';

// GET /v1/businesses and /facets (BF-022) over a small hand-built workspace: every filter, sort, cursor paging,
// the three text rankers (full text, name trigram, embeddings via deterministic fake vectors) and facets.

const embedded: string[] = [];
const fakeGateway = {
  embed: async (texts: readonly string[]) => {
    embedded.push(...texts);
    return { vectors: texts.map((t) => fakeEmbedding(t)), model: 'fake', dims: 1536 };
  },
} as unknown as AiGateway;

const mailer = new FakeMailer();
let t: TestApp;
let db: DbClient;
let owner: Browser;
let other: Browser;
let ownerId: string;
let ownerOrg: string;
let otherOrg: string;
let gustavia: { id: string; lat: number; lng: number };
let lorient: { lat: number; lng: number };
const category = new Map<string, string>();
const ids: Record<string, string> = {};

const at = (minutesAgo: number) => new Date(Date.UTC(2026, 9, 14, 11, 0) - minutesAgo * 60_000);

async function addBusiness(
  key: string,
  overrides: Partial<BusinessFixture>,
  options: {
    readonly categories?: readonly string[];
    readonly org?: Partial<typeof orgBusinesses.$inferInsert> | null;
    readonly emails?: ReadonlyArray<'valid' | 'unknown'>;
  } = {},
): Promise<void> {
  const business = aBusiness(overrides);
  ids[key] = business.id;
  await db.insert(businesses).values(business);
  for (const [index, slug] of (options.categories ?? []).entries()) {
    await db.insert(businessCategories).values({
      businessId: business.id,
      categoryId: category.get(slug) as string,
      isPrimary: index === 0,
      confidence: 1,
      source: 'manual',
    });
  }
  for (const status of options.emails ?? []) {
    await db
      .insert(businessContacts)
      .values({ ...aContact({ businessId: business.id, type: 'email' }), verificationStatus: status });
  }
  if (options.org !== null) {
    await db.insert(orgBusinesses).values({
      organizationId: ownerOrg,
      businessId: business.id,
      addedVia: 'search',
      ...options.org,
    });
  }
}

beforeAll(async () => {
  t = await createTestApp({ mailer, valkeyDb: 12, overrides: [{ token: AI_GATEWAY, value: fakeGateway }] });
  db = t.app.get(DB_CLIENT);
  await runInTransaction(db, (tx) => seedTaxonomy(tx, loadTaxonomy()));
  await importPack(GEO_PACKS.bl as never, new DrizzleGeoAreaRepository(db));
  for (const row of (await db.execute(sql`SELECT id, slug FROM categories`)) as unknown as Array<{
    id: string;
    slug: string;
  }>) {
    category.set(row.slug, row.id);
  }
  const inside = async (name: string) => {
    const [row] = (await db.execute(sql`
      SELECT id, ST_Y(ST_PointOnSurface(geom::geometry)) AS lat, ST_X(ST_PointOnSurface(geom::geometry)) AS lng
      FROM geo_areas WHERE name->>'en' = ${name} AND organization_id IS NULL
      ORDER BY area_km2 DESC NULLS LAST LIMIT 1`)) as unknown as Array<{
      id: string;
      lat: number;
      lng: number;
    }>;
    return row as { id: string; lat: number; lng: number };
  };
  gustavia = await inside('Gustavia');
  lorient = await inside('Lorient');

  owner = await signUpVerified(t, mailer, 'owner@listing.test', 'Lise Listing');
  ownerOrg = await createWorkspace(owner, 'Agence Liste');
  other = await signUpVerified(t, mailer, 'other@listing.test', 'Otto Other');
  otherOrg = await createWorkspace(other, 'Autre Liste');
  const [me] = (await db.execute(
    sql`SELECT id FROM users WHERE email = 'owner@listing.test'`,
  )) as unknown as Array<{ id: string }>;
  ownerId = me?.id as string;

  const here = (p: { lat: number; lng: number }) => ({ location: { lat: p.lat, lng: p.lng } });
  await addBusiness(
    'salon',
    {
      displayName: 'Salon Belle Mèche',
      ...here(gustavia),
      locality: 'Gustavia',
      ratingAvg: 4.6,
      ratingCount: 120,
      priceLevel: 3,
    },
    {
      categories: ['hair_salon'],
      emails: ['valid'],
      org: {
        createdAt: at(50),
        score: 80,
        tier: 'A',
        tags: ['vip'],
        pipelineStatus: 'qualified',
        ownerUserId: ownerId,
      },
    },
  );
  await addBusiness(
    'cafe',
    {
      displayName: 'Café des Arts',
      ...here(gustavia),
      locality: 'Gustavia',
      websiteUrl: null,
      websiteHost: null,
      websiteRegistrableDomain: null,
      primaryPhoneE164: null,
      ratingAvg: 3.8,
      ratingCount: 15,
      priceLevel: 1,
    },
    { categories: ['cafe'], org: { createdAt: at(40), score: 40, tier: 'C' } },
  );
  await addBusiness(
    'creole',
    {
      displayName: 'Le Ti Coin Créole',
      priceLevel: 2,
      ...here(lorient),
      locality: 'Lorient',
      ratingAvg: 4.2,
      ratingCount: 60,
    },
    {
      categories: ['restaurant'],
      emails: ['unknown'],
      org: { createdAt: at(30), pipelineStatus: 'contacted' },
    },
  );
  await addBusiness(
    'pizzeria',
    {
      displayName: 'Pizzeria Lulu',
      priceLevel: 2,
      ...here(lorient),
      locality: 'Lorient',
      ratingAvg: null,
      ratingCount: null,
    },
    { categories: ['pizzeria'], org: { createdAt: at(20), score: 80, tier: 'A' } },
  );
  await addBusiness(
    'closed',
    { displayName: 'Boulangerie du Fort', operatingStatus: 'closed_permanently', ...here(gustavia) },
    { categories: ['bakery'], org: { createdAt: at(10) } },
  );
  // Not tracked by the workspace, or tracked by another one: never listed.
  await addBusiness(
    'untracked',
    { displayName: 'Café Fantôme', ...here(gustavia) },
    { categories: ['cafe'], org: null },
  );
  await addBusiness(
    'foreign',
    { displayName: 'Café Voisin', ...here(gustavia) },
    { categories: ['cafe'], org: null },
  );
  await db
    .insert(orgBusinesses)
    .values({ organizationId: otherOrg, businessId: ids.foreign as string, addedVia: 'search' });
  // Semantic-only match: no word in common with the query, an embedding equal to the query's.
  await db
    .update(businesses)
    .set({
      embedding: fakeEmbedding('somewhere to buy hammocks'),
      embeddingModel: t.app.get(APP_ENV).AI_EMBEDDING_MODEL,
    })
    .where(sql`${businesses.id} = ${ids.creole}`);
});

afterAll(async () => {
  await t?.close();
});

const list = async (query = '', client: Browser = owner) => {
  const res = await client.get(`/v1/businesses${query ? `?${query}` : ''}`).expect(200);
  return res.body as { items: Array<Record<string, unknown> & { id: string }>; nextCursor: string | null };
};
const names = async (query = '') => (await list(query)).items.map((i) => i.displayName);
const keyOf = (id: string) => Object.entries(ids).find(([, v]) => v === id)?.[0];
const keys = async (query = '') => (await list(query)).items.map((i) => keyOf(i.id));

async function walk(query: string): Promise<Array<string | undefined>> {
  const seen: Array<string | undefined> = [];
  let cursor: string | null = null;
  do {
    const page = await list(`${query}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    seen.push(...page.items.map((i) => keyOf(i.id)));
    cursor = page.nextCursor;
  } while (cursor);
  return seen;
}

describe('GET /v1/businesses', () => {
  it('lists tracked, open businesses of the workspace only, most recently tracked first', async () => {
    const page = await list();
    expect(page.items.map((i) => keyOf(i.id))).toEqual(['pizzeria', 'creole', 'cafe', 'salon']);
    expect(page.items.at(-1)).toMatchObject({
      displayName: 'Salon Belle Mèche',
      score: 80,
      tier: 'A',
      tags: ['vip'],
      pipelineStatus: 'qualified',
      ownerUserId: ownerId,
      distanceMeters: null,
      hasEmail: true,
      addedVia: 'search',
    });
    expect(await keys('includeClosed=true')).toContain('closed');
    expect((await list('', other)).items.map((i) => keyOf(i.id))).toEqual(['foreign']);
  });

  it.each([
    ['category with its subcategories', `category=${'restaurant'}`, ['pizzeria', 'creole']],
    ['several categories', 'category=cafe,hair_salon', ['cafe', 'salon']],
    ['no website', 'website=none', ['cafe']],
    // `weak` reads the latest website audit (BF-030): none here (website-audit.int.test.ts covers the rest).
    ['a weak website', 'website=weak', []],
    ['rating ≥ 4', 'rating[gte]=4', ['creole', 'salon']],
    ['reviews ≤ 60', 'reviews[lte]=60', ['creole', 'cafe']],
    ['with an email', 'hasEmail=true', ['creole', 'salon']],
    ['without an email', 'hasEmail=false', ['pizzeria', 'cafe']],
    ['a verified email', 'emailVerified=true', ['salon']],
    ['no phone', 'hasPhone=false', ['cafe']],
    ['pipeline status', 'status=qualified&status=contacted', ['creole', 'salon']],
    ['tier', 'tier=C', ['cafe']],
    ['tag', 'tag=vip,other', ['salon']],
    ['score ≥ 50', 'score[gte]=50', ['pizzeria', 'salon']],
    ['price level', 'price=1', ['cafe']],
    ['country', 'country=FR', []],
    ['keyword', 'keyword=pizzeria', ['pizzeria']],
  ])('filters by %s', async (_label, query, expected) => {
    const resolved = query.replace(
      /category=([a-z_,]+)/,
      (_m, slugs: string) =>
        `category=${slugs
          .split(',')
          .map((s) => category.get(s))
          .join(',')}`,
    );
    expect(await keys(resolved)).toEqual(expected);
  });

  it('filters by area, radius, owner and recency', async () => {
    expect(await keys(`area=${gustavia.id}`)).toEqual(['cafe', 'salon']);
    expect(await keys(`near=${lorient.lat},${lorient.lng}&radiusKm=0.5`)).toEqual(['pizzeria', 'creole']);
    expect(await keys(`owner=${ownerId}`)).toEqual(['salon']);
    expect(await keys(`id=${ids.salon},${ids.cafe},${ids.untracked}`)).toEqual(['cafe', 'salon']);
    expect(await keys('addedWithinDays=1')).toHaveLength(4);
    await owner.get('/v1/businesses?area=0192a1b2-0000-7000-8000-000000000999').expect(404);
    const run = '0192a1b2-0000-7000-8000-0000000000ff';
    await db.execute(sql`UPDATE org_businesses SET added_via = 'discovery', added_ref = ${run}
      WHERE business_id = ${ids.cafe}`);
    expect(await keys(`run=${run}`)).toEqual(['cafe']);
    await db.execute(
      sql`UPDATE org_businesses SET added_via = 'search', added_ref = NULL WHERE business_id = ${ids.cafe}`,
    );
  });

  it('sorts with nulls last and pages every sort with cursors', async () => {
    const byScore = await keys('sort=-score');
    // salon and pizzeria tie on 80: the id breaks the tie (random ids here), the null score comes last.
    expect(byScore.slice(0, 2).sort()).toEqual(['pizzeria', 'salon']);
    expect(byScore.slice(2)).toEqual(['cafe', 'creole']);
    expect(await keys('sort=rating')).toEqual(['cafe', 'creole', 'salon', 'pizzeria']);
    expect(await keys('sort=name')).toEqual(['cafe', 'creole', 'pizzeria', 'salon']);
    const near = await list(`near=${gustavia.lat},${gustavia.lng}&radiusKm=50&sort=distance`);
    expect(
      near.items
        .slice(0, 2)
        .map((i) => keyOf(i.id))
        .sort(),
    ).toEqual(['cafe', 'salon']);
    expect(near.items[0]?.distanceMeters).toBe(0);
    for (const sort of ['-score', 'score', 'rating', '-reviews', 'name', '-recent', 'recent']) {
      expect(await walk(`sort=${sort}`), sort).toEqual(await keys(`sort=${sort}`));
    }
    expect(await walk(`sort=distance&near=${lorient.lat},${lorient.lng}&radiusKm=50`)).toHaveLength(4);
  });

  it('ranks free text with full text, name similarity and meaning', async () => {
    expect(await names('q=cafe')).toEqual(['Café des Arts']); // accent-insensitive full text
    expect(await names('q=creole')).toEqual(['Le Ti Coin Créole']);
    expect(await names('q=coiffure')).toEqual(['Salon Belle Mèche']); // category label (French)
    expect(await names('q=lulu')).toEqual(['Pizzeria Lulu']); // name trigram
    expect(await keys('q=somewhere to buy hammocks')).toEqual(['creole']); // embedding only
    expect(embedded).toContain('somewhere to buy hammocks');
    expect(await keys('q=restaurant')).toEqual(expect.arrayContaining(['creole', 'pizzeria']));
    expect(await walk('q=restaurant')).toEqual(await keys('q=restaurant'));
    expect(await keys('q=restaurant&status=contacted')).toEqual(['creole']);
  });

  it('rejects bad cursors, impossible sorts and anonymous callers', async () => {
    await owner.get('/v1/businesses?cursor=garbage').expect(422);
    const page = await list('sort=-score&limit=1');
    await owner
      .get(`/v1/businesses?sort=rating&cursor=${encodeURIComponent(page.nextCursor as string)}`)
      .expect(422);
    await owner.get('/v1/businesses?sort=distance').expect(422);
    await owner.get('/v1/businesses?status=nope').expect(422);
    await t.http.get('/v1/businesses').expect(401);
  });
});

describe('GET /v1/businesses/facets', () => {
  const facets = async (query = '') =>
    (await owner.get(`/v1/businesses/facets${query ? `?${query}` : ''}`).expect(200)).body as {
      total: number;
      categories: Array<{ slug: string; count: number }>;
      pipelineStatuses: Array<{ value: string; count: number }>;
      tiers: Array<{ value: string; count: number }>;
      website: Array<{ value: string; count: number }>;
      email: Array<{ value: string; count: number }>;
      ratingBands: Array<{ value: string; count: number }>;
      localities: Array<{ value: string; count: number }>;
    };

  it('counts each dimension under the other filters, consistent with the list', async () => {
    const all = await facets();
    expect(all.total).toBe((await list()).items.length);
    expect(all.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'food_drink', count: 3 }),
        expect.objectContaining({ slug: 'beauty_wellness', count: 1 }),
      ]),
    );
    expect(all.website).toEqual(
      expect.arrayContaining([
        { value: 'has', count: 3 },
        { value: 'none', count: 1 },
      ]),
    );
    expect(all.email).toEqual(
      expect.arrayContaining([
        { value: 'has', count: 2 },
        { value: 'none', count: 2 },
      ]),
    );
    expect(all.ratingBands).toEqual(
      expect.arrayContaining([
        { value: 'gte4.5', count: 1 },
        { value: 'none', count: 1 },
      ]),
    );
    expect(all.localities).toEqual([
      { value: 'Gustavia', count: 2 },
      { value: 'Lorient', count: 2 },
    ]);
    // Picking a status keeps the other statuses' counts; the total follows the filter.
    const qualified = await facets('status=qualified');
    expect(qualified.total).toBe(1);
    expect(qualified.pipelineStatuses).toEqual(all.pipelineStatuses);
    expect(qualified.tiers).toEqual([{ value: 'A', count: 1 }]);
    // Children of a selected category appear.
    const food = await facets(`category=${category.get('food_drink')}`);
    expect(food.total).toBe(3);
    expect(food.categories.map((c) => c.slug)).toEqual(expect.arrayContaining(['restaurant', 'cafe']));
  });

  it('counts the ranked text results', async () => {
    const text = await facets('q=restaurant');
    expect(text.total).toBe((await list('q=restaurant')).items.length);
    // A selected status still shows the other statuses of the ranked results.
    const contacted = await facets('q=restaurant&status=contacted');
    expect(contacted.total).toBe(1);
    expect(contacted.pipelineStatuses.map((p) => p.value).sort()).toEqual(['contacted', 'new']);
  });
});
