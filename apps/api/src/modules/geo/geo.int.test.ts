import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { DbClient } from '@bf/db';
import { geoAreas } from '@bf/db/schema';
import { eq, sql } from 'drizzle-orm';
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
import { GEO_PACKS, importPack } from './application/packs/index.ts';
import { DrizzleGeoAreaRepository } from './infrastructure/drizzle-geo-area.repository.ts';

/** Recorded-shape Nominatim answers (fake data). */
const MIAMI_BEACH = [
  {
    osm_type: 'relation',
    osm_id: 1210692,
    lat: '25.79',
    lon: '-80.13',
    display_name: 'Miami Beach, Miami-Dade County, Florida, United States',
    importance: 0.75,
    addresstype: 'city',
    boundingbox: ['25.76', '25.87', '-80.15', '-80.11'],
    geojson: {
      type: 'Polygon',
      coordinates: [
        [
          [-80.15, 25.76],
          [-80.11, 25.76],
          [-80.11, 25.87],
          [-80.15, 25.87],
          [-80.15, 25.76],
        ],
      ],
    },
    address: { country_code: 'us' },
  },
];

// A local stand-in for Nominatim. MSW is not used here: on Node it intercepts at the socket level, which breaks
// the Postgres client.
const nominatimCalls: Array<{ q: string | null; userAgent: string | null; countrycodes: string | null }> = [];
const nominatim: Server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/search') {
    res.writeHead(404).end();
    return;
  }
  nominatimCalls.push({
    q: url.searchParams.get('q'),
    userAgent: req.headers['user-agent'] ?? null,
    countrycodes: url.searchParams.get('countrycodes'),
  });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(url.searchParams.get('q') === 'Miami Beach' ? MIAMI_BEACH : []));
});

const mailer = new FakeMailer();
let t: TestApp;
let db: DbClient;
let owner: Browser;
let viewer: Browser;
let outsider: Browser;

beforeAll(async () => {
  await new Promise<void>((resolve) => nominatim.listen(0, '127.0.0.1', resolve));
  const nominatimUrl = `http://127.0.0.1:${(nominatim.address() as AddressInfo).port}`;
  t = await createTestApp({
    mailer,
    valkeyDb: 3,
    env: {
      NOMINATIM_BASE_URL: nominatimUrl,
      NOMINATIM_CONTACT_EMAIL: 'ops@example.test',
    },
  });
  db = t.app.get(DB_CLIENT);
  owner = await signUpVerified(t, mailer, 'owner@geo.test', 'Olive Owner');
  await createWorkspace(owner, 'Agence');
  viewer = (await inviteAndJoin(t, mailer, owner, 'viewer@geo.test', 'viewer')).client;
  outsider = await signUpVerified(t, mailer, 'outsider@geo.test', 'Other Owner');
  await createWorkspace(outsider, 'Elsewhere');
});

afterAll(async () => {
  nominatim.close();
  await t?.close();
});

describe('BL pack', () => {
  it('imports the island and its quarters idempotently', async () => {
    const repository = new DrizzleGeoAreaRepository(db);
    const first = await importPack(GEO_PACKS.bl as never, repository);
    expect(first.written).toBeGreaterThan(10);
    const second = await importPack(GEO_PACKS.bl as never, repository);
    expect(second).toMatchObject({ written: 0, unchanged: first.written });
    const [island] = await db.select().from(geoAreas).where(eq(geoAreas.kind, 'island'));
    expect(island).toMatchObject({ countryCode: 'BL', code: 'BL', approximate: false, source: 'osm' });
    expect(island?.areaKm2).toBeGreaterThan(15);
    expect(island?.areaKm2).toBeLessThan(30);
    const islandId = island?.id as string;
    const quarters = await db
      .select({
        name: geoAreas.name,
        approximate: geoAreas.approximate,
        inside: sql<boolean>`ST_CoveredBy(${geoAreas.geom}::geometry, ST_Buffer((SELECT g.geom FROM geo_areas g WHERE g.id = ${islandId})::geometry, 0.0001))`,
      })
      .from(geoAreas)
      .where(eq(geoAreas.parentId, islandId));
    expect(quarters.length).toBeGreaterThan(10);
    expect(quarters.every((q) => q.approximate && q.inside)).toBe(true);
    expect(quarters.map((q) => q.name.local)).toEqual(
      expect.arrayContaining(['Gustavia', 'Lorient', 'Flamands']),
    );
  });
});

describe('national packs', () => {
  const fixture = (name: string) => fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));

  it('imports NL PC4 and US ZCTA exports (ZCTA filtered by prefix) and resolves postcodes to them', async () => {
    const repository = new DrizzleGeoAreaRepository(db);
    const nl = await importPack(GEO_PACKS['nl-pc4'] as never, repository, {
      file: fixture('nl-pc4.geojsonseq'),
    });
    expect(nl).toMatchObject({ written: 2, unchanged: 0 });
    const us = await importPack(GEO_PACKS['us-zcta'] as never, repository, {
      file: fixture('us-zcta.geojsonseq'),
      prefix: '33',
    });
    expect(us).toMatchObject({ written: 2, unchanged: 0 });
    expect(
      await importPack(GEO_PACKS['us-zcta'] as never, repository, {
        file: fixture('us-zcta.geojsonseq'),
        prefix: '33',
      }),
    ).toMatchObject({ written: 0, unchanged: 2 });

    for (const [q, code, country] of [
      ['1012', '1012', 'NL'],
      ['1012 AB', '1012', 'NL'],
      ['33139', '33139', 'US'],
    ] as const) {
      const res = await viewer.get(`/v1/geo/resolve?q=${encodeURIComponent(q)}&locale=en`).expect(200);
      expect(res.body.candidates[0], q).toMatchObject({ kind: 'postal_code', source: 'local' });
      const area = await viewer.get(`/v1/geo/areas/${res.body.candidates[0].areaId}`).expect(200);
      expect(area.body.properties, q).toMatchObject({ code, countryCode: country });
    }
    const filtered = await db.select().from(geoAreas).where(eq(geoAreas.sourceRef, 'us-zcta:10001'));
    expect(filtered).toEqual([]);
  });
});

describe('GET /v1/geo/resolve', () => {
  it.each(['St Barth', 'Saint-Barthélemy', 'SBH', 'St Barts'])('%s → the BL island', async (q) => {
    const res = await viewer.get(`/v1/geo/resolve?q=${encodeURIComponent(q)}&locale=fr`).expect(200);
    expect(res.body.candidates[0]).toMatchObject({ kind: 'island', source: 'local' });
    expect(res.body.chosen).toBe(0);
  });

  it('resolves quarters and radius phrases, with the workspace country as hint', async () => {
    await owner.patch('/v1/workspace/settings', { defaultCountryCode: 'BL' }).expect(200);
    const gustavia = await viewer.get('/v1/geo/resolve?q=Gustavia&locale=fr').expect(200);
    expect(gustavia.body.candidates[0]).toMatchObject({
      kind: 'locality',
      label: 'Gustavia, Saint-Barthélemy',
    });
    expect(gustavia.body.candidates[0].geometry.type).toBe('MultiPolygon');
    const radius = await viewer
      .get(`/v1/geo/resolve?q=${encodeURIComponent('within 3 km of Lorient')}&locale=en`)
      .expect(200);
    expect(radius.body.candidates[0]).toMatchObject({
      source: 'pattern',
      geometry: { type: 'Circle', radiusM: 3000 },
    });
  });

  it('geocodes unknown places through Nominatim within its policy, then answers from the cache and the stored area', async () => {
    const res = await viewer
      .get(`/v1/geo/resolve?q=${encodeURIComponent('Miami Beach')}&locale=en&country=US`)
      .expect(200);
    expect(res.body.candidates[0]).toMatchObject({
      source: 'geocoder',
      kind: 'locality',
      geometry: { type: 'MultiPolygon' },
    });
    expect(nominatimCalls).toHaveLength(1);
    expect(nominatimCalls[0]?.userAgent).toMatch(/^BusinessFinder\/.+ ops@example\.test$/);
    expect(nominatimCalls[0]?.countrycodes).toBe('us');
    const again = await viewer
      .get(`/v1/geo/resolve?q=${encodeURIComponent('Miami Beach')}&locale=en&country=US`)
      .expect(200);
    expect(again.body.candidates[0]).toMatchObject({ source: 'local' });
    expect(nominatimCalls).toHaveLength(1);
  });

  it('spaces Nominatim calls at least a second apart', async () => {
    const before = nominatimCalls.length;
    const started = Date.now();
    await viewer.get('/v1/geo/resolve?q=Nowhere%20One&locale=en').expect(200);
    await viewer.get('/v1/geo/resolve?q=Nowhere%20Two&locale=en').expect(200);
    expect(nominatimCalls.length - before).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  });

  it('needs authentication', async () => {
    await t.http.get('/v1/geo/resolve?q=Gustavia').expect(401);
  });
});

describe('areas', () => {
  it('serves typeahead and GeoJSON, and keeps custom areas private to their workspace', async () => {
    const search = await viewer.get('/v1/geo/areas?q=flamand&locale=fr').expect(200);
    expect(search.body.items[0]).toMatchObject({ kind: expect.any(String), countryCode: 'BL' });
    const feature = await viewer.get(`/v1/geo/areas/${search.body.items[0].id}?locale=fr`).expect(200);
    expect(feature.body).toMatchObject({ type: 'Feature', geometry: { type: 'MultiPolygon' } });

    const polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-62.86, 17.89],
          [-62.84, 17.89],
          [-62.84, 17.9],
          [-62.86, 17.9],
          [-62.86, 17.89],
        ],
      ],
    };
    await viewer.post('/v1/geo/areas', { name: 'Zone Nord', geometry: polygon }).expect(403);
    const created = await owner.post('/v1/geo/areas', { name: 'Zone Nord', geometry: polygon }).expect(201);
    expect(created.body).toMatchObject({ kind: 'custom', source: 'custom', label: 'Zone Nord' });
    await viewer.get(`/v1/geo/areas/${created.body.id}`).expect(200);
    await outsider.get(`/v1/geo/areas/${created.body.id}`).expect(404);
    expect((await outsider.get('/v1/geo/areas?q=Zone%20Nord').expect(200)).body.items).toEqual([]);

    // A retried request returns the same area instead of a duplicate.
    const retried = await owner.post('/v1/geo/areas', { name: 'Zone Nord', geometry: polygon }).expect(201);
    expect(retried.body.id).toBe(created.body.id);
    // The outsider drawing the same outline gets its own private area.
    const theirs = await outsider.post('/v1/geo/areas', { name: 'Zone Nord', geometry: polygon }).expect(201);
    expect(theirs.body.id).not.toBe(created.body.id);
  });

  it('rejects self-intersecting and oversized outlines', async () => {
    const bowTie = {
      type: 'Polygon',
      coordinates: [
        [
          [-62.86, 17.89],
          [-62.84, 17.9],
          [-62.84, 17.89],
          [-62.86, 17.9],
          [-62.86, 17.89],
        ],
      ],
    };
    const invalid = await owner.post('/v1/geo/areas', { name: 'Noeud', geometry: bowTie }).expect(422);
    expect(invalid.body.errors[0].message).toMatch(/self-intersection/i);
    // Short coordinates keep the body under the request size limit, so the vertex cap is what rejects it.
    const many = Array.from({ length: 5_001 }, (_, k) => [k % 7, k % 5]);
    const tooMany = await owner
      .post('/v1/geo/areas', {
        name: 'Trop',
        geometry: { type: 'Polygon', coordinates: [[...many, many[0]]] },
      })
      .expect(422);
    expect(JSON.stringify(tooMany.body.errors)).toMatch(/At most 5000 vertices/);
  });
});
