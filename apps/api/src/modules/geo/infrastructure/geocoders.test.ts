import { ExternalServiceError } from '@bf/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../platform/config/app-env.ts';
import type { SecretResolver } from '../../workspace/index.ts';
import {
  GoogleGeocoder,
  kindFromNominatim,
  MAX_GEOCODED_VERTICES,
  NominatimGeocoder,
  polygonOf,
} from './geocoders.ts';

// External HTTP is stubbed at the boundary (fetch); fake data only.
const respond = (body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (_url: URL) =>
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    ),
  );
const lastUrl = () => {
  const call = vi.mocked(fetch).mock.calls.at(-1);
  if (!call) throw new Error('fetch was not called');
  return (call[0] as URL).searchParams;
};

afterEach(() => vi.unstubAllGlobals());

const ring = (n: number) => [
  ...Array.from({ length: n - 1 }, (_, i) => [i / n, Math.sin(i) / 10] as [number, number]),
  [0, 0] as [number, number],
];

describe('Nominatim answers', () => {
  const env = {
    NOMINATIM_BASE_URL: 'https://nominatim.example.test',
    NOMINATIM_CONTACT_EMAIL: 'ops@example.test',
  };
  const valkey = { set: vi.fn(async () => 'OK'), pttl: vi.fn(async () => 0) };
  const geocoder = new NominatimGeocoder(env as unknown as AppEnv, valkey as never);
  const query = { text: 'x', countryHint: 'BL', strictCountry: false, locale: 'en', orgId: null } as const;

  it('maps place types to area kinds, and keeps roads, buildings and shops as points', () => {
    expect(kindFromNominatim('city')).toBe('locality');
    expect(kindFromNominatim('suburb')).toBe('district');
    expect(kindFromNominatim('postcode')).toBe('postal_code');
    for (const t of ['road', 'building', 'shop', 'house', 'amenity', undefined])
      expect(kindFromNominatim(t)).toBeNull();
  });

  it('accepts only valid, reasonably sized polygons', () => {
    const square = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ],
    };
    expect(polygonOf(square)?.type).toBe('MultiPolygon');
    expect(
      polygonOf({
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        ],
      }),
    ).toBeNull();
    expect(
      polygonOf({
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [500, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      }),
    ).toBeNull();
    expect(polygonOf({ type: 'Point', coordinates: [0, 0] })).toBeNull();
    expect(polygonOf({ type: 'Polygon', coordinates: [ring(MAX_GEOCODED_VERTICES + 10)] })).toBeNull();
  });

  it('skips malformed places, drops POI outlines and only filters by country when asked', async () => {
    respond([
      { lat: 'nope', lon: '1', display_name: 'Broken' },
      {
        osm_type: 'way',
        osm_id: 7,
        lat: '17.9',
        lon: '-62.85',
        display_name: 'Some Shop, Gustavia',
        addresstype: 'shop',
        boundingbox: ['17.89', '17.91', '-62.86', '-62.84'],
        geojson: {
          type: 'Polygon',
          coordinates: [
            [
              [-62.86, 17.89],
              [-62.84, 17.89],
              [-62.84, 17.91],
              [-62.86, 17.89],
            ],
          ],
        },
      },
    ]);
    const results = await geocoder.geocode(query);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: 'custom', persistable: false, geometry: null });
    expect(lastUrl().get('countrycodes')).toBeNull();
    respond([]);
    await geocoder.geocode({ ...query, strictCountry: true });
    expect(lastUrl().get('countrycodes')).toBe('bl');
  });
});

describe('Google answers', () => {
  const secrets = { resolve: vi.fn(async () => ({ value: 'fake-key' })) } as unknown as SecretResolver;
  const geocoder = new GoogleGeocoder(secrets);
  const query = { text: 'x', countryHint: 'US', strictCountry: true, locale: 'en', orgId: 'org' } as const;

  it('treats denied or invalid requests as failures, not as "no results"', async () => {
    respond({ status: 'REQUEST_DENIED', results: [] });
    await expect(geocoder.geocode(query)).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it('returns no results for ZERO_RESULTS and restricts to the country when asked', async () => {
    respond({ status: 'ZERO_RESULTS', results: [] });
    expect(await geocoder.geocode(query)).toEqual([]);
    expect(lastUrl().get('components')).toBe('country:US');
    expect(geocoder).toMatchObject({ perWorkspace: true, cacheDays: 30 });
  });
});
