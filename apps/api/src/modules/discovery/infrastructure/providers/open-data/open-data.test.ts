import { ExternalServiceError, fixedClock, type OpenDataPlace, type ProviderQuery } from '@bf/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { IntelClient } from '../../../../platform/intel/intel-client.ts';
import { openDataRecord } from './mapper.ts';
import { OpenDataProvider } from './provider.ts';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const CAFE = '00000000-0000-7000-8000-000000000001';
const place = (over: Partial<OpenDataPlace> = {}): OpenDataPlace => ({
  id: '08f-001',
  name: 'Café Fictif',
  categories: [
    { key: 'cafe', label: null },
    { key: 'coffee_shop', label: null },
  ],
  location: { lat: 17.8963, lng: -62.8499 },
  address: {
    line1: '12 Rue de l’Exemple',
    city: 'Gustavia',
    postalCode: '97133',
    region: null,
    countryCode: 'BL',
  },
  phones: ['+590 590 00 00 01'],
  websites: ['https://cafe-fictif.example', 'javascript:alert(1)', 'https://autre.example'],
  emails: [],
  socials: ['https://www.instagram.com/cafe_fictif'],
  operatingStatus: 'temporarily_closed',
  confidence: 0.92,
  brand: null,
  sources: [{ dataset: 'meta', recordId: '123', license: 'CDLA-Permissive-2.0' }],
  ...over,
});

function setup(places: OpenDataPlace[], release: string | null = null) {
  const post = vi.fn(async () => ({
    dataset: 'overture' as const,
    release: '2026-09-23.1',
    places,
    nextCursor: 'next-cursor',
    cached: false,
  }));
  const intel = { post } as unknown as IntelClient;
  const provider = new OpenDataProvider({
    dataset: 'overture',
    intel,
    clock: fixedClock(NOW),
    releaseFor: async () => release,
  });
  return { provider, post };
}

const box = { type: 'BBox' as const, bbox: { west: -62.88, south: 17.87, east: -62.79, north: 17.93 } };
const context = { organizationId: 'org-1', credential: null, signal: new AbortController().signal };

describe('open-data records', () => {
  it('maps places to storable records with per-source licences', () => {
    expect(openDataRecord('overture', '2026-09-23.1', place(), NOW)).toMatchSnapshot();
  });

  it('keeps only http(s) links and drops invalid places', () => {
    const record = openDataRecord('overture', 'r', place(), NOW);
    expect(record?.website).toBe('https://cafe-fictif.example');
    expect(record?.attributes).toMatchObject({ otherWebsites: ['https://autre.example'] });
    expect(record?.expiresAt).toBeUndefined();
    expect(openDataRecord('overture', 'r', place({ name: '' }), NOW)).toBeNull();
  });
});

describe('OpenDataProvider', () => {
  it('builds one category-key query per category and none for keywords alone', () => {
    const { provider } = setup([]);
    const keys = new Map([
      [
        CAFE,
        [
          { key: 'cafe', label: null },
          { key: 'coffee_shop', label: null },
        ],
      ],
    ]);
    expect(
      provider.buildQueries({
        intent: { categoryIds: [CAFE], languageCode: 'fr' },
        tile: box,
        keysByCategory: keys,
        fieldTier: 'pro',
      }),
    ).toEqual([expect.objectContaining({ providerKeys: ['cafe', 'coffee_shop'], mode: 'search' })]);
    expect(
      provider.buildQueries({
        intent: { categoryIds: [], keywords: 'yoga', languageCode: 'fr' },
        tile: box,
        keysByCategory: keys,
        fieldTier: 'pro',
      }),
    ).toEqual([]);
  });

  it('asks intel with the tile box, pinned release, cursor and the open-data policy', async () => {
    const { provider, post } = setup([place()], '2026-08-19.0');
    const query = {
      provider: 'overture',
      categoryId: CAFE,
      providerKeys: ['cafe'],
      tile: box,
      languageCode: 'fr',
      fieldTier: 'pro',
      mode: 'search',
      pageNumber: 1,
      pageToken: 'prev-cursor',
    } satisfies ProviderQuery;
    const page = await provider.fetchPage(query, context);
    expect(post).toHaveBeenCalledWith(
      '/v1/open-data/places/search',
      {
        dataset: 'overture',
        release: '2026-08-19.0',
        geometry: box,
        categories: ['cafe'],
        limit: 200,
        cursor: 'prev-cursor',
      },
      expect.anything(),
      expect.objectContaining({ policy: 'intel-open-data' }),
    );
    expect(page).toMatchObject({
      nextPageToken: '2026-09-23.1|next-cursor',
      saturated: false,
      sku: 'open_data',
    });
    // The next page keeps the first page's release, whatever the workspace setting says by then.
    await provider.fetchPage({ ...query, pageToken: '2026-09-23.1|next-cursor' }, context);
    expect(post).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ release: '2026-09-23.1', cursor: 'next-cursor' }),
      expect.anything(),
      expect.anything(),
    );
    expect(page.records[0]).toMatchObject({
      provider: 'overture',
      providerRef: '08f-001',
      operatingStatus: 'closed_temporarily',
    });
  });

  it('passes the Hugging Face token for Foursquare and drops places outside a circle tile', async () => {
    const post = vi.fn(async () => ({
      dataset: 'foursquare' as const,
      release: '2026-09-15',
      places: [place(), place({ id: 'far', location: { lat: 17.92, lng: -62.82 } })],
      nextCursor: null,
      cached: true,
    }));
    const provider = new OpenDataProvider({
      dataset: 'foursquare',
      intel: { post } as unknown as IntelClient,
      clock: fixedClock(NOW),
    });
    expect(provider.secretName).toBe('huggingface');
    const circle = { type: 'Circle' as const, center: { lat: 17.8963, lng: -62.8499 }, radiusM: 500 };
    const page = await provider.fetchPage(
      {
        provider: 'foursquare',
        categoryId: CAFE,
        providerKeys: ['4bf58dd8d48988d1e0931735'],
        tile: circle,
        languageCode: 'fr',
        fieldTier: 'pro',
        mode: 'search',
        pageNumber: 0,
      },
      { ...context, credential: { value: 'hf_fakeTokenForTests123456', source: 'workspace' } },
    );
    expect(post).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        hfToken: 'hf_fakeTokenForTests123456',
        geometry: { type: 'BBox', bbox: expect.any(Object) },
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(page.records.map((r) => r.providerRef)).toEqual(['08f-001']);
    expect(page.records[0]?.provider).toBe('foursquare');
  });

  it('checks a Hugging Face token with whoami', async () => {
    const provider = new OpenDataProvider({
      dataset: 'foursquare',
      intel: {} as IntelClient,
      clock: fixedClock(NOW),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 })),
    );
    expect(
      await provider.testConnection({ value: 'hf_x', source: 'workspace' }, new AbortController().signal),
    ).toMatchObject({ ok: false });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ name: 'fixture' })),
    );
    expect(
      await provider.testConnection({ value: 'hf_x', source: 'workspace' }, new AbortController().signal),
    ).toMatchObject({ ok: true });
    vi.unstubAllGlobals();
  });

  it('surfaces intel failures', async () => {
    const intel = {
      post: vi.fn(async () => {
        throw new ExternalServiceError('intel', 'down');
      }),
    } as unknown as IntelClient;
    const provider = new OpenDataProvider({ dataset: 'overture', intel, clock: fixedClock(NOW) });
    const [query] = setup([]).provider.buildQueries({
      intent: { categoryIds: [CAFE], languageCode: 'fr' },
      tile: box,
      keysByCategory: new Map([[CAFE, [{ key: 'cafe', label: null }]]]),
      fieldTier: 'pro',
    });
    await expect(provider.fetchPage(query as ProviderQuery, context)).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
  });
});
