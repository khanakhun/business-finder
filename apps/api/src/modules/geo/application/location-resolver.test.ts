import { ExternalServiceError, type MultiPolygon } from '@bf/contracts';
import { createLogger } from '@bf/observability';
import { describe, expect, it, vi } from 'vitest';
import { normalizeAreaName } from '../domain/area-names.ts';
import { LocationResolver } from './location-resolver.ts';
import type {
  AreaMatch,
  GeoAreaRecord,
  GeoAreaRepository,
  GeocodeCache,
  GeocodeCacheKey,
  GeocodeQuota,
  GeocodeResult,
  Geocoder,
} from './ports.ts';

const square = (lng: number, lat: number, d = 0.01): MultiPolygon => ({
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [lng, lat],
        [lng + d, lat],
        [lng + d, lat + d],
        [lng, lat + d],
        [lng, lat],
      ],
    ],
  ],
});

const area = (
  id: string,
  names: string[],
  over: Partial<GeoAreaRecord> = {},
): GeoAreaRecord & { names: string[] } => ({
  id,
  kind: 'locality',
  countryCode: 'BL',
  code: null,
  name: { en: names[0] as string, fr: names[0] as string },
  aliases: names.slice(1),
  parentId: null,
  approximate: true,
  source: 'osm',
  sourceRef: id,
  areaKm2: 1,
  centroid: { lat: 17.9, lng: -62.85 },
  bbox: { west: -62.86, south: 17.89, east: -62.84, north: 17.91 },
  organizationId: null,
  names,
  ...over,
});

const AREAS = [
  area('island', ['Saint-Barthélemy', 'St Barth', 'SBH', 'St Barts', '97133'], {
    kind: 'island',
    code: 'BL',
    approximate: false,
  }),
  area('gustavia', ['Gustavia'], { parentId: 'island' }),
  area('saint-jean-bl', ['Saint-Jean'], { parentId: 'island' }),
  area('saint-jean-fr', ['Saint-Jean'], { countryCode: 'FR' }),
  area('pc4-1012', ['1012'], { kind: 'postal_code', countryCode: 'NL', code: '1012' }),
];

function harness(
  options: {
    geocoder?: Geocoder | null;
    cached?: GeocodeResult[];
    quota?: boolean;
    extra?: typeof AREAS;
  } = {},
) {
  const areas = [...AREAS, ...(options.extra ?? [])];
  const repository = {
    match: vi.fn(async (text: string): Promise<AreaMatch[]> => {
      const q = normalizeAreaName(text);
      if (!q) return [];
      return areas
        .filter((a) => a.names.some((n) => normalizeAreaName(n) === q || normalizeAreaName(n).includes(q)))
        .map((a) => {
          const exact = a.names.some((n) => normalizeAreaName(n) === q);
          return { area: a, score: 1, exact };
        });
    }),
    findByCode: vi.fn(async (kind: string, code: string, country: string) =>
      areas.find((a) => a.kind === kind && a.code === code && a.countryCode === country),
    ),
    displayGeometries: vi.fn(
      async (ids: readonly string[]) => new Map(ids.map((id) => [id, square(-62.86, 17.89)])),
    ),
    names: vi.fn(async () => new Map([['island', { en: 'Saint Barthélemy', fr: 'Saint-Barthélemy' }]])),
    upsert: vi.fn(async () => ({ id: 'persisted', changed: true })),
  } as unknown as GeoAreaRepository;
  const store = new Map<string, GeocodeResult[]>();
  const keyOf = (k: GeocodeCacheKey) => `${k.query}|${k.provider}|${k.countryHint}|${k.locale}|${k.scope}`;
  if (options.cached) store.set('miami beach|nominatim||en|', options.cached);
  const cache: GeocodeCache = {
    get: vi.fn(async (k) => store.get(keyOf(k))),
    put: vi.fn(async (k, results) => {
      store.set(keyOf(k), [...results]);
    }),
  };
  const quota: GeocodeQuota = { take: vi.fn(async () => options.quota ?? true) };
  const resolver = new LocationResolver(
    repository,
    cache,
    quota,
    createLogger({ service: 'test', level: 'fatal' }),
    options.geocoder ?? null,
  );
  return { resolver, repository, cache, quota };
}

const nominatim = (geocode: Geocoder['geocode']): Geocoder => ({
  provider: 'nominatim',
  perWorkspace: false,
  cacheDays: 90,
  geocode,
});

const MIAMI: GeocodeResult[] = [
  {
    label: 'Miami Beach, Florida, United States',
    countryCode: 'US',
    kind: 'locality',
    persistable: true,
    center: { lat: 25.79, lng: -80.13 },
    bbox: { west: -80.15, south: 25.76, east: -80.11, north: 25.87 },
    geometry: square(-80.15, 25.76, 0.04),
    sourceRef: 'osm:relation/1',
    importance: 0.8,
  },
  {
    label: 'Miami Beach (point)',
    countryCode: 'US',
    kind: 'locality',
    persistable: true,
    center: { lat: 25.8, lng: -80.13 },
    bbox: null,
    geometry: null,
    sourceRef: 'osm:node/2',
    importance: 0.4,
  },
];

const bl = { locale: 'fr', countryHint: 'BL', organizationId: null } as const;
const en = { locale: 'en', countryHint: null, organizationId: null } as const;

describe('LocationResolver', () => {
  it.each(['St Barth', 'Saint-Barthélemy', 'SBH', 'st barts'])('%s → the island', async (q) => {
    const { resolver } = harness();
    const result = await resolver.resolve(q, bl);
    expect(result.candidates[0]).toMatchObject({ areaId: 'island', kind: 'island', source: 'local' });
    expect(result.chosen).toBe(0);
    expect(result.notice).toBeNull();
  });

  it('labels localities with their parent', async () => {
    const result = await harness().resolver.resolve('Gustavia', bl);
    expect(result.candidates[0]).toMatchObject({ areaId: 'gustavia', label: 'Gustavia, Saint-Barthélemy' });
  });

  it('ranks an ambiguous name by the country hint, and stays ambiguous without one', async () => {
    const { resolver } = harness();
    const hinted = await resolver.resolve('Saint-Jean', bl);
    expect(hinted.candidates.map((c) => c.areaId)).toEqual(['saint-jean-bl', 'saint-jean-fr']);
    expect(hinted.chosen).toBe(0);
    const open = await resolver.resolve('Saint-Jean', { ...bl, countryHint: null });
    expect(open.candidates).toHaveLength(2);
    expect(open.chosen).toBeNull();
  });

  it('never auto-picks a partial name match', async () => {
    const result = await harness().resolver.resolve('Gusta', bl);
    expect(result.candidates[0]).toMatchObject({ areaId: 'gustavia' });
    expect(result.candidates[0]?.confidence).toBeLessThanOrEqual(0.75);
    expect(result.chosen).toBeNull();
  });

  it('resolves radius phrases (EN/FR) into circles around the place', async () => {
    const { resolver } = harness();
    const fr = await resolver.resolve('dans un rayon de 2 km autour de Gustavia', bl);
    expect(fr.candidates[0]).toMatchObject({
      kind: 'custom',
      source: 'pattern',
      label: '2 km autour de Gustavia, Saint-Barthélemy',
    });
    expect(fr.candidates[0]?.geometry).toMatchObject({ type: 'Circle', radiusM: 2000 });
    const enResult = await resolver.resolve('within 3 km of Gustavia', { ...bl, locale: 'en' });
    expect(enResult.candidates[0]?.label).toMatch(/^3 km around Gustavia/);
    const point = await resolver.resolve('17.9, -62.85', bl);
    expect(point.candidates[0]).toMatchObject({
      confidence: 1,
      geometry: { center: { lat: 17.9, lng: -62.85 }, radiusM: 1000 },
    });
  });

  it('finds postcodes in imported packs, and asks the geocoder (restricted to the country) otherwise', async () => {
    const { resolver } = harness();
    expect((await resolver.resolve('1012 AB', bl)).candidates[0]).toMatchObject({
      areaId: 'pc4-1012',
      confidence: 0.95,
    });
    const geocode = vi.fn(async () => [] as GeocodeResult[]);
    const withGeocoder = harness({ geocoder: nominatim(geocode) });
    expect((await withGeocoder.resolver.resolve('33139', { ...bl, countryHint: 'US' })).candidates).toEqual(
      [],
    );
    expect(geocode).toHaveBeenCalledWith(
      expect.objectContaining({ text: '33139, United States', countryHint: 'US', strictCountry: true }),
    );
  });

  it('reads bare digits as a local postcode when the workspace is elsewhere (97133 is Saint-Barthélemy)', async () => {
    const geocode = vi.fn(async () => [] as GeocodeResult[]);
    const { resolver } = harness({ geocoder: nominatim(geocode) });
    const result = await resolver.resolve('97133', bl);
    expect(result.candidates[0]).toMatchObject({ areaId: 'island' });
    expect(geocode).not.toHaveBeenCalled();
  });

  it('falls back to the geocoder, caches answers and stores polygon results as areas', async () => {
    const geocode = vi.fn(async () => MIAMI);
    const { resolver, repository, cache } = harness({ geocoder: nominatim(geocode) });
    const first = await resolver.resolve('Miami Beach', en);
    expect(first.candidates[0]).toMatchObject({ areaId: 'persisted', source: 'geocoder', confidence: 0.64 });
    expect(first.candidates[1]?.geometry).toMatchObject({ type: 'Circle', radiusM: 2000 });
    expect(repository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'nominatim', sourceRef: 'osm:relation/1' }),
    );
    expect(cache.put).toHaveBeenCalledWith(expect.anything(), MIAMI, 90 * 86_400);
    await resolver.resolve('miami  beach', en);
    expect(geocode).toHaveBeenCalledTimes(1);
  });

  it('shares one provider call between identical lookups in flight', async () => {
    const geocode = vi.fn(async () => MIAMI);
    const { resolver } = harness({ geocoder: nominatim(geocode) });
    await Promise.all([resolver.resolve('Miami Beach', en), resolver.resolve('Miami Beach', en)]);
    expect(geocode).toHaveBeenCalledTimes(1);
  });

  it('caches empty answers briefly and keeps the workspace default country a bias, not a filter', async () => {
    const geocode = vi.fn(async () => [] as GeocodeResult[]);
    const { resolver, cache } = harness({ geocoder: nominatim(geocode) });
    await resolver.resolve('Paris', bl);
    expect(geocode).toHaveBeenCalledWith(
      expect.objectContaining({ countryHint: 'BL', strictCountry: false }),
    );
    expect(cache.put).toHaveBeenCalledWith(expect.objectContaining({ countryHint: '' }), [], 6 * 3600);
  });

  it('stores only administrative answers, and survives an area PostGIS rejects', async () => {
    const poi = { ...MIAMI[0], label: 'Some Shop, Miami Beach', persistable: false } as GeocodeResult;
    const geocode = vi.fn(async () => [poi]);
    const { resolver, repository } = harness({ geocoder: nominatim(geocode) });
    const result = await resolver.resolve('Some Shop', en);
    expect(repository.upsert).not.toHaveBeenCalled();
    expect(result.candidates[0]).toMatchObject({ areaId: null, geometry: { type: 'Circle' } });

    const failing = harness({ geocoder: nominatim(vi.fn(async () => MIAMI)) });
    vi.mocked(failing.repository.upsert).mockRejectedValueOnce(new Error('invalid geometry'));
    const degraded = await failing.resolver.resolve('Miami Beach', en);
    expect(degraded.candidates[0]).toMatchObject({ areaId: null, geometry: { type: 'Circle' } });
  });

  it('does not let an area stored from the geocoder hide other places with that name', async () => {
    const stored = area('paris-tx', ['Paris'], { countryCode: 'US', source: 'nominatim' });
    const geocode = vi.fn(async () => [] as GeocodeResult[]);
    const { resolver } = harness({ geocoder: nominatim(geocode), extra: [stored] });
    await resolver.resolve('Paris', en);
    expect(geocode).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a provider error', new ExternalServiceError('nominatim', 'down')],
    [
      'an open circuit',
      Object.assign(new Error('Execution prevented because the circuit breaker is open'), {
        name: 'BrokenCircuitError',
      }),
    ],
    ['a network failure', new TypeError('fetch failed')],
  ])('degrades to local results on %s', async (_, failure) => {
    const geocode = vi.fn(async () => {
      throw failure;
    });
    const result = await harness({ geocoder: nominatim(geocode) }).resolver.resolve('Nowhere', bl);
    expect(result).toEqual({
      query: 'Nowhere',
      candidates: [],
      chosen: null,
      notice: 'geocoder_unavailable',
    });
  });

  it('stops asking the geocoder once the workspace quota is spent', async () => {
    const geocode = vi.fn(async () => MIAMI);
    const { resolver } = harness({ geocoder: nominatim(geocode), quota: false });
    const result = await resolver.resolve('Miami Beach', en);
    expect(result.notice).toBe('geocoder_quota');
    expect(geocode).not.toHaveBeenCalled();
  });

  it('serves cached answers without spending quota, and skips the geocoder for empty queries', async () => {
    const geocode = vi.fn(async () => MIAMI);
    const { resolver, quota } = harness({ geocoder: nominatim(geocode), cached: MIAMI, quota: false });
    expect((await resolver.resolve('Miami Beach', en)).candidates).toHaveLength(2);
    expect(quota.take).not.toHaveBeenCalled();
    expect((await resolver.resolve('???', en)).candidates).toEqual([]);
    expect(geocode).not.toHaveBeenCalled();
  });
});
