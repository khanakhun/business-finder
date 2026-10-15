import { readFileSync } from 'node:fs';
import { ExternalServiceError, fixedClock, type ProviderQuery, RateLimitedError } from '@bf/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { retryAfterSeconds } from './client.ts';
import { fieldMask, skuFor } from './field-masks.ts';
import { toSourceRecord } from './mapper.ts';
import { GooglePlacesProvider } from './provider.ts';

// Contract tests: recorded-shape (synthetic, scrubbed) Places API (New) responses → normalized records. External
// HTTP is stubbed at the boundary; no live calls.
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'));

const NOW = new Date('2026-10-15T12:00:00.000Z');
const provider = new GooglePlacesProvider(fixedClock(NOW));
const credential = { value: 'fake-test-key', source: 'workspace' as const };
const context = { organizationId: 'org-1', credential, signal: new AbortController().signal };
const CAFE = '00000000-0000-7000-8000-000000000001';
const BAKERY = '00000000-0000-7000-8000-000000000002';
const intent = { categoryIds: [CAFE, BAKERY], languageCode: 'fr', regionCode: 'BL' };
const keysByCategory = new Map([
  [
    CAFE,
    [
      { key: 'cafe', label: 'café' },
      { key: 'coffee_shop', label: null },
    ],
  ],
  [BAKERY, [{ key: 'bakery', label: 'boulangerie' }]],
]);
const box = { type: 'BBox' as const, bbox: { west: -62.88, south: 17.87, east: -62.79, north: 17.93 } };
const circle = { type: 'Circle' as const, center: { lat: 17.9, lng: -62.85 }, radiusM: 1500 };

const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => {
  const fetchMock = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const sent = (mock: ReturnType<typeof respond>) => {
  const [url, init] = mock.mock.calls.at(-1) ?? [];
  const headers = new Headers(init?.headers);
  return {
    url,
    body: JSON.parse(String(init?.body)),
    mask: headers.get('x-goog-fieldmask'),
    key: headers.get('x-goog-api-key'),
  };
};

afterEach(() => vi.unstubAllGlobals());

describe('field masks and SKUs', () => {
  it('stop at the tier, never request Atmosphere fields, and page only Text Search', () => {
    expect(fieldMask('text', 'pro')).toContain('nextPageToken');
    expect(fieldMask('nearby', 'pro')).not.toContain('nextPageToken');
    expect(fieldMask('text', 'pro')).not.toContain('websiteUri');
    expect(fieldMask('text', 'enterprise')).toContain('places.websiteUri');
    for (const mask of [fieldMask('text', 'enterprise'), fieldMask('nearby', 'enterprise')]) {
      expect(mask).not.toMatch(/reviews|photos|editorialSummary|generativeSummary/);
    }
    expect(fieldMask('text', 'essentials')).toBe(fieldMask('text', 'pro'));
    expect(skuFor('nearby', 'enterprise')).toBe('nearby_search_enterprise');
    expect(skuFor('text', 'essentials')).toBe('text_search_pro');
  });
});

describe('mapping', () => {
  it('normalizes a recorded Text Search page', () => {
    const places = (fixture('text-search.json') as { places: unknown[] }).places;
    const records = places.flatMap((p) => toSourceRecord(p, NOW) ?? []);
    expect(records).toHaveLength(3);
    expect(records).toMatchSnapshot();
  });

  it('keeps only the place id of the payload and expires content after 30 days', () => {
    const [place] = (fixture('text-search.json') as { places: unknown[] }).places;
    const record = toSourceRecord(place, NOW);
    expect(record?.raw).toEqual({ id: 'ChIJFakePlace0000000000001' });
    expect(record?.expiresAt).toBe('2026-11-14T12:00:00.000Z');
    expect(record?.hours?.[0]).toEqual({ weekday: 0, opensAt: '07:00', closesAt: '18:30' });
    expect(record?.address).toMatchObject({
      line1: "12 Rue de l'Exemple",
      city: 'Gustavia',
      countryCode: 'BL',
    });
  });
});

describe('queries', () => {
  it('uses Nearby Search per category for circles and Text Search per type for boxes or keywords', () => {
    const nearby = provider.buildQueries({ intent, tile: circle, keysByCategory, fieldTier: 'pro' });
    expect(nearby.map((q) => [q.mode, q.providerKeys])).toEqual([
      ['nearby', ['cafe', 'coffee_shop']],
      ['nearby', ['bakery']],
    ]);
    const text = provider.buildQueries({ intent, tile: box, keysByCategory, fieldTier: 'pro' });
    expect(text.map((q) => [q.mode, q.providerKeys, q.keywords])).toEqual([
      ['text', ['cafe'], 'café'],
      ['text', ['coffee_shop'], 'coffee shop'],
      ['text', ['bakery'], 'boulangerie'],
    ]);
    const keywordsOnly = provider.buildQueries({
      intent: { categoryIds: [], keywords: 'yacht charter', languageCode: 'en' },
      tile: circle,
      keysByCategory,
      fieldTier: 'enterprise',
    });
    expect(keywordsOnly).toEqual([
      expect.objectContaining({ mode: 'text', categoryId: null, keywords: 'yacht charter' }),
    ]);
    expect(provider.skuFor(keywordsOnly[0] as never)).toBe('text_search_enterprise');
  });

  it('sends a rectangle-restricted Text Search with the tier mask and the key in a header only', async () => {
    const mock = respond(200, fixture('text-search.json'));
    const [query] = provider.buildQueries({ intent, tile: box, keysByCategory, fieldTier: 'enterprise' });
    const page = await provider.fetchPage(query as never, context);
    const request = sent(mock);
    expect(request.url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(request.key).toBe('fake-test-key');
    expect(request.url).not.toContain('fake-test-key');
    expect(request.mask).toBe(fieldMask('text', 'enterprise'));
    expect(request.body).toMatchObject({
      textQuery: 'café',
      includedType: 'cafe',
      strictTypeFiltering: true,
      languageCode: 'fr',
      regionCode: 'BL',
      pageSize: 20,
      locationRestriction: {
        rectangle: {
          low: { latitude: 17.87, longitude: -62.88 },
          high: { latitude: 17.93, longitude: -62.79 },
        },
      },
    });
    expect(page).toMatchObject({
      nextPageToken: 'FAKE_NEXT_PAGE_TOKEN_1',
      saturated: false,
      sku: 'text_search_enterprise',
    });
    expect(page.records).toHaveLength(3);
  });

  it('marks full answers as saturated (Nearby at 20; Text Search on its third full page)', async () => {
    const twenty = {
      places: Array.from({ length: 20 }, (_, i) => ({
        id: `fake-${i}`,
        displayName: { text: `Fictif ${i}` },
      })),
    };
    const mock = respond(200, twenty);
    const [nearbyQuery] = provider.buildQueries({ intent, tile: circle, keysByCategory, fieldTier: 'pro' });
    expect((await provider.fetchPage(nearbyQuery as never, context)).saturated).toBe(true);
    expect(sent(mock).body).toMatchObject({
      includedTypes: ['cafe', 'coffee_shop'],
      maxResultCount: 20,
      rankPreference: 'DISTANCE',
      locationRestriction: { circle: { center: { latitude: 17.9, longitude: -62.85 }, radius: 1500 } },
    });
    const [textQuery] = provider.buildQueries({ intent, tile: box, keysByCategory, fieldTier: 'pro' });
    respond(200, twenty);
    expect(
      (await provider.fetchPage({ ...(textQuery as ProviderQuery), pageNumber: 0 }, context)).saturated,
    ).toBe(false);
    respond(200, twenty);
    const last = await provider.fetchPage(
      { ...(textQuery as ProviderQuery), pageNumber: 2, pageToken: 't' },
      context,
    );
    expect(last.saturated).toBe(true);
    expect(sent(vi.mocked(fetch) as never).body.pageToken).toBe('t');
  });

  it('maps errors: 429 → rate limited with Retry-After, 403 → non-retryable, without quoting the key', async () => {
    const [query] = provider.buildQueries({ intent, tile: box, keysByCategory, fieldTier: 'pro' });
    respond(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, { 'retry-after': '7' });
    const limited = await provider.fetchPage(query as never, context).catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(RateLimitedError);
    expect((limited as RateLimitedError).retryAfterSeconds).toBe(7);
    respond(403, fixture('permission-denied.json'));
    const denied = await provider.fetchPage(query as never, context).catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(ExternalServiceError);
    expect((denied as ExternalServiceError).details).toMatchObject({
      reason: 'PERMISSION_DENIED',
      retryable: false,
    });
    expect(String((denied as Error).message)).not.toContain('fake-test-key');
  });

  it('tests the connection with a free IDs-only call', async () => {
    const mock = respond(200, { places: [{ id: 'x' }] });
    expect(await provider.testConnection(credential, new AbortController().signal)).toMatchObject({
      ok: true,
    });
    expect(sent(mock).mask).toBe('places.id,nextPageToken');
  });

  it('parses Retry-After seconds and dates, bounded', () => {
    expect(retryAfterSeconds('3')).toBe(3);
    expect(retryAfterSeconds('600')).toBe(60);
    expect(retryAfterSeconds(new Date(Date.now() + 5_000).toUTCString())).toBeLessThanOrEqual(5);
    expect(retryAfterSeconds('soon')).toBeUndefined();
    expect(retryAfterSeconds(null)).toBeUndefined();
  });
});

describe('review cases', () => {
  it('treats an empty nextPageToken as the last page', async () => {
    const twenty = {
      places: Array.from({ length: 20 }, (_, i) => ({
        id: `fake-${i}`,
        displayName: { text: `Fictif ${i}` },
      })),
      nextPageToken: '',
    };
    respond(200, twenty);
    const [textQuery] = provider.buildQueries({ intent, tile: box, keysByCategory, fieldTier: 'pro' });
    const page = await provider.fetchPage({ ...(textQuery as ProviderQuery), pageNumber: 2 }, context);
    expect(page.nextPageToken).toBeNull();
    expect(page.saturated).toBe(true);
  });

  it('falls back to a keyword search when no category has a Google type', () => {
    const queries = provider.buildQueries({
      intent: { categoryIds: ['00000000-0000-7000-8000-00000000000f'], keywords: 'yoga', languageCode: 'fr' },
      tile: box,
      keysByCategory: new Map(),
      fieldTier: 'pro',
    });
    expect(queries).toEqual([expect.objectContaining({ mode: 'text', categoryId: null, keywords: 'yoga' })]);
  });

  it('drops Text Search results outside a circle tile (its rectangle corners)', async () => {
    respond(200, {
      places: [
        { id: 'in', displayName: { text: 'Dedans' }, location: { latitude: 17.9, longitude: -62.85 } },
        { id: 'corner', displayName: { text: 'Coin' }, location: { latitude: 17.912, longitude: -62.8375 } },
      ],
    });
    const [query] = provider.buildQueries({
      intent: { categoryIds: [], keywords: 'cafe', languageCode: 'fr' },
      tile: circle,
      keysByCategory,
      fieldTier: 'pro',
    });
    const page = await provider.fetchPage(query as ProviderQuery, context);
    expect(page.records.map((r) => r.providerRef)).toEqual(['in']);
  });

  it('counts pages per endpoint for estimates', () => {
    const [nearby] = provider.buildQueries({ intent, tile: circle, keysByCategory, fieldTier: 'pro' });
    const [text] = provider.buildQueries({ intent, tile: box, keysByCategory, fieldTier: 'pro' });
    expect(provider.maxPages(nearby as ProviderQuery)).toBe(1);
    expect(provider.maxPages(text as ProviderQuery)).toBe(3);
  });

  it('maps edge cases: overnight hours, unknown statuses and prices, postal towns, unsafe links, oversized text', () => {
    const record = toSourceRecord(
      {
        id: 'edge',
        displayName: { text: '  Bar de Nuit  ' },
        businessStatus: 'FUTURE_OPENING',
        priceLevel: 'PRICE_LEVEL_UNSPECIFIED',
        websiteUri: 'javascript:alert(1)',
        googleMapsUri: 'https://maps.google.com/?cid=1',
        nationalPhoneNumber: '0'.repeat(80),
        formattedAddress: 'x'.repeat(1_000),
        addressComponents: [{ longText: 'Townsville', types: ['postal_town'] }],
        regularOpeningHours: {
          periods: [
            { open: { day: 5, hour: 22, minute: 0 }, close: { day: 6, hour: 2, minute: 0 } },
            { open: { day: 6, hour: 22, minute: 0 } },
          ],
        },
      },
      NOW,
    );
    expect(record).toMatchObject({
      name: 'Bar de Nuit',
      operatingStatus: 'unknown',
      address: { city: 'Townsville' },
      hours: [{ weekday: 4, opensAt: '22:00', closesAt: '02:00' }],
    });
    expect(record?.priceLevel).toBeUndefined();
    expect(record?.website).toBeUndefined();
    expect(record?.phones?.[0]).toHaveLength(40);
    expect(record?.address?.formatted).toHaveLength(400);
  });

  it('rejects a 2xx answer that is not JSON as a retryable upstream error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>oops</html>', { status: 200 })),
    );
    const [query] = provider.buildQueries({ intent, tile: box, keysByCategory, fieldTier: 'pro' });
    const error = await provider.fetchPage(query as ProviderQuery, context).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect((error as ExternalServiceError).details?.retryable).not.toBe(false);
  });
});
