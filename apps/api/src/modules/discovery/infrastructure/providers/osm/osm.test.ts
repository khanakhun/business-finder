import { readFileSync } from 'node:fs';
import { ExternalServiceError, fixedClock, type ProviderQuery, RateLimitedError } from '@bf/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type OverpassElement, osmRecord } from './mapper.ts';
import { parseOpeningHours } from './opening-hours.ts';
import { overpassQuery, tagFilter } from './overpass.ts';
import { OsmOverpassProvider } from './provider.ts';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/overpass.json', import.meta.url), 'utf8'),
) as {
  elements: OverpassElement[];
};
const box = { type: 'BBox' as const, bbox: { west: -62.88, south: 17.87, east: -62.79, north: 17.93 } };
const CAFE = '00000000-0000-7000-8000-000000000001';

afterEach(() => vi.unstubAllGlobals());

describe('Overpass QL', () => {
  it('filters named elements by tags in (south,west,north,east) boxes or around circles', () => {
    expect(overpassQuery(['amenity=cafe', 'shop=coffee'], box, 500)).toBe(
      '[out:json][timeout:25];(nwr["amenity"="cafe"]["name"](17.87,-62.88,17.93,-62.79);' +
        'nwr["shop"="coffee"]["name"](17.87,-62.88,17.93,-62.79););out center tags 500;',
    );
    expect(
      overpassQuery(['craft'], { type: 'Circle', center: { lat: 17.9, lng: -62.85 }, radiusM: 1500.4 }, 10),
    ).toContain('nwr["craft"]["name"](around:1500,17.9,-62.85);');
  });

  it('escapes values and rejects invalid keys', () => {
    // Quotes are escaped: the value stays inside the QL string.
    expect(tagFilter('name="x"];out;')).toBe('["name"="\\"x\\"];out;"]');
    expect(tagFilter('amenity=a"b')).toBe('["amenity"="a\\"b"]');
    expect(() => overpassQuery(['bad key=x'], box, 1)).toThrow();
  });
});

describe('opening_hours', () => {
  it.each([
    [
      'Mo-Fr 09:00-18:00',
      [0, 1, 2, 3, 4].map((weekday) => ({ weekday, opensAt: '09:00', closesAt: '18:00' })),
    ],
    [
      'Mo 08:00-12:00,14:00-18:00; Su off',
      [
        { weekday: 0, opensAt: '08:00', closesAt: '12:00' },
        { weekday: 0, opensAt: '14:00', closesAt: '18:00' },
      ],
    ],
    ['Sa-Mo 10:00-24:00', [0, 5, 6].map((weekday) => ({ weekday, opensAt: '10:00', closesAt: '23:59' }))],
    ['Fr 22:00-02:00', [{ weekday: 4, opensAt: '22:00', closesAt: '02:00' }]],
    [
      'Mo-Su 08:00-20:00; We off',
      [0, 1, 3, 4, 5, 6].map((weekday) => ({ weekday, opensAt: '08:00', closesAt: '20:00' })),
    ],
  ])('%s', (value, expected) => {
    expect(parseOpeningHours(value)).toEqual(expected);
  });

  it('accepts rules separated by commas before a weekday', () => {
    expect(parseOpeningHours('Mo-Fr 09:00-18:00, Sa 10:00-12:00')).toHaveLength(6);
    expect(parseOpeningHours('Mo,We 09:00-12:00')).toEqual([
      { weekday: 0, opensAt: '09:00', closesAt: '12:00' },
      { weekday: 2, opensAt: '09:00', closesAt: '12:00' },
    ]);
  });

  it('handles 24/7 and refuses what it cannot represent', () => {
    expect(parseOpeningHours('24/7')).toHaveLength(7);
    for (const value of [
      'sunrise-sunset',
      'Jan-Mar Mo 09:00-12:00',
      'Mo-Fr 09:00-18:00 "by appointment"',
      '',
      undefined,
    ]) {
      expect(parseOpeningHours(value)).toBeUndefined();
    }
    expect(parseOpeningHours('Mo-Fr 09:00-18:00; PH off')).toHaveLength(5);
  });
});

describe('OSM records', () => {
  it('maps recorded Overpass elements (named only, centres for ways)', () => {
    const records = fixture.elements.flatMap((e) => osmRecord(e, NOW) ?? []);
    expect(records).toHaveLength(2);
    expect(records).toMatchSnapshot();
    expect(records[1]?.website).toBe('https://www.boulangerie-demo.example');
    expect(records[1]?.hours).toBeUndefined();
  });
});

describe('OsmOverpassProvider', () => {
  const provider = new OsmOverpassProvider({
    clock: fixedClock(NOW),
    endpoint: 'https://overpass.example.test/api/interpreter',
    contactEmail: 'ops@example.test',
  });
  const [query] = provider.buildQueries({
    intent: { categoryIds: [CAFE], languageCode: 'fr' },
    tile: box,
    keysByCategory: new Map([
      [
        CAFE,
        [
          { key: 'amenity=cafe', label: null },
          { key: 'bad key', label: null },
        ],
      ],
    ]),
    fieldTier: 'pro',
  });
  const context = { organizationId: 'org-1', credential: null, signal: new AbortController().signal };

  it('posts the query with an identifying User-Agent and maps the answer', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(fixture));
    vi.stubGlobal('fetch', fetchMock);
    const page = await provider.fetchPage(query as ProviderQuery, context);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://overpass.example.test/api/interpreter');
    expect(new Headers(init?.headers).get('user-agent')).toMatch(/^BusinessFinder\/.* ops@example\.test$/);
    expect(String(init?.body)).toContain('data=');
    expect(query?.providerKeys).toEqual(['amenity=cafe']);
    expect(page).toMatchObject({ saturated: false, nextPageToken: null, sku: 'overpass' });
    expect(page.records.map((r) => r.providerRef)).toEqual(['node/1000000001', 'way/2000000002']);
  });

  it('treats a runtime-error remark as a failed (retryable) query', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ elements: [], remark: 'runtime error: Query timed out in "query" at line 1' }),
      ),
    );
    const error = await provider.fetchPage(query as ProviderQuery, context).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect((error as ExternalServiceError).details?.retryable).toBe(true);
  });

  it('backs off 30 s on 429 as the usage policy asks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('busy', { status: 429 })),
    );
    const error = await provider.fetchPage(query as ProviderQuery, context).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryAfterSeconds).toBe(30);
  });
});
