import {
  ExternalServiceError,
  type GeoAreaKind,
  type MultiPolygon,
  MultiPolygonSchema,
  PolygonSchema,
  RateLimitedError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { APP_ENV, type AppEnv } from '../../platform/config/app-env.ts';
import { WithResilience } from '../../platform/resilience/resilience.ts';
import { VALKEY } from '../../platform/valkey/valkey.module.ts';
import { SecretResolver } from '../../workspace/index.ts';
import type { GeocodeQuery, GeocodeResult, Geocoder } from '../application/ports.ts';
import { toMultiPolygon } from '../domain/geometry.ts';

const isValidBbox = (b: { west: number; south: number; east: number; north: number }) =>
  [b.west, b.east].every((x) => Number.isFinite(x) && Math.abs(x) <= 180) &&
  [b.south, b.north].every((y) => Number.isFinite(y) && Math.abs(y) <= 90) &&
  b.south <= b.north;

const USER_AGENT_BASE = 'BusinessFinder/0.1 (+https://github.com/khanakhun/business-finder)';

/**
 * Nominatim `addresstype` → our area kind, for places that are areas. Roads, buildings, shops and other features
 * return null: they stay point candidates and are never stored as areas (that would leak what someone searched
 * for to every workspace and pollute name lookups).
 */
export function kindFromNominatim(addresstype: string | undefined): GeoAreaKind | null {
  switch (addresstype) {
    case 'country':
      return 'country';
    case 'state':
      return 'admin1';
    case 'county':
    case 'region':
    case 'state_district':
      return 'admin2';
    case 'city':
    case 'town':
    case 'village':
    case 'municipality':
    case 'hamlet':
      return 'locality';
    case 'suburb':
    case 'quarter':
    case 'neighbourhood':
    case 'city_district':
    case 'borough':
      return 'district';
    case 'postcode':
      return 'postal_code';
    case 'island':
    case 'archipelago':
    case 'islet':
      return 'island';
    default:
      return null;
  }
}

const NominatimPlace = z.object({
  osm_type: z.string().optional(),
  osm_id: z.number().optional(),
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  display_name: z.string().max(500),
  importance: z.number().optional(),
  addresstype: z.string().optional(),
  boundingbox: z
    .tuple([z.coerce.number(), z.coerce.number(), z.coerce.number(), z.coerce.number()])
    .optional(),
  geojson: z.object({ type: z.string(), coordinates: z.unknown() }).optional(),
  address: z.object({ country_code: z.string().optional() }).passthrough().optional(),
});

/** Above this many vertices a boundary is dropped (the place falls back to a point + radius). */
export const MAX_GEOCODED_VERTICES = 20_000;

/** Valid polygon boundaries of a reasonable size only (points, lines and malformed shapes become null). */
export function polygonOf(geojson: { type: string; coordinates: unknown } | undefined): MultiPolygon | null {
  if (!geojson) return null;
  const parsed = z.union([PolygonSchema, MultiPolygonSchema]).safeParse(geojson);
  if (!parsed.success) return null;
  const geometry = toMultiPolygon(parsed.data);
  const vertices = geometry.coordinates.flat().reduce((n, ring) => n + ring.length, 0);
  return vertices <= MAX_GEOCODED_VERTICES ? geometry : null;
}

/**
 * Nominatim (OpenStreetMap) geocoder honouring its usage policy: one request per second across every process
 * (Valkey token), an identifying User-Agent with a contact address, polygons requested, results cached by the
 * caller. Point `NOMINATIM_BASE_URL` at a self-hosted instance for volume.
 */
@Injectable()
export class NominatimGeocoder implements Geocoder {
  readonly provider = 'nominatim' as const;
  readonly perWorkspace = false;
  readonly cacheDays = 90;

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {}

  @WithResilience('geocoder')
  async geocode(query: GeocodeQuery): Promise<GeocodeResult[]> {
    await this.takeToken();
    const url = new URL('/search', this.env.NOMINATIM_BASE_URL);
    url.searchParams.set('q', query.text);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('polygon_geojson', '1');
    url.searchParams.set('polygon_threshold', '0.0005');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('limit', '5');
    url.searchParams.set('accept-language', query.locale);
    // A workspace's default country only biases ranking (the resolver does that): as a filter it would hide
    // "Paris" from a Saint-Barthélemy workspace.
    if (query.countryHint && query.strictCountry)
      url.searchParams.set('countrycodes', query.countryHint.toLowerCase());
    if (this.env.NOMINATIM_CONTACT_EMAIL) url.searchParams.set('email', this.env.NOMINATIM_CONTACT_EMAIL);
    const response = await fetch(url, {
      headers: {
        'User-Agent': this.env.NOMINATIM_CONTACT_EMAIL
          ? `${USER_AGENT_BASE} ${this.env.NOMINATIM_CONTACT_EMAIL}`
          : USER_AGENT_BASE,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 429) throw new RateLimitedError('Nominatim rate limit reached.');
    if (!response.ok) throw new ExternalServiceError('nominatim', `answered ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body)) throw new ExternalServiceError('nominatim', 'unexpected response');
    // Places that do not validate are skipped rather than failing the whole answer.
    return body.flatMap((raw): GeocodeResult[] => {
      const parsed = NominatimPlace.safeParse(raw);
      if (!parsed.success) return [];
      const place = parsed.data;
      const kind = kindFromNominatim(place.addresstype);
      const [south, north, west, east] = place.boundingbox ?? [];
      const bbox =
        south !== undefined && north !== undefined && west !== undefined && east !== undefined
          ? { west, south, east, north }
          : null;
      return [
        {
          label: place.display_name,
          countryCode: place.address?.country_code?.toUpperCase() ?? null,
          kind: kind ?? 'custom',
          persistable: kind !== null,
          center: { lat: place.lat, lng: place.lon },
          bbox: bbox && isValidBbox(bbox) ? bbox : null,
          geometry: kind ? polygonOf(place.geojson) : null,
          sourceRef: `osm:${place.osm_type ?? 'place'}/${place.osm_id ?? place.display_name}`,
          importance: Math.max(0, Math.min(1, place.importance ?? 0.3)),
        },
      ];
    });
  }

  /** At most one request per second, deployment-wide (waits up to 1.5 s for its turn, then gives up). */
  private async takeToken(): Promise<void> {
    const key = 'bf:geo:nominatim:token';
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      if ((await this.valkey.set(key, '1', 'PX', 1_000, 'NX')) === 'OK') return;
      const ttl = await this.valkey.pttl(key);
      await new Promise((resolve) => setTimeout(resolve, Math.max(50, Math.min(ttl, 1_000))));
    }
    throw new RateLimitedError('Geocoder busy, try again shortly.');
  }
}

const GoogleResponse = z.object({
  status: z.string(),
  results: z.array(
    z.object({
      formatted_address: z.string(),
      place_id: z.string(),
      types: z.array(z.string()),
      geometry: z.object({
        location: z.object({ lat: z.number(), lng: z.number() }),
        viewport: z
          .object({
            northeast: z.object({ lat: z.number(), lng: z.number() }),
            southwest: z.object({ lat: z.number(), lng: z.number() }),
          })
          .optional(),
      }),
      address_components: z
        .array(z.object({ short_name: z.string(), types: z.array(z.string()) }))
        .default([]),
    }),
  ),
});

const googleKind = (types: readonly string[]): GeoAreaKind =>
  types.includes('country')
    ? 'country'
    : types.includes('administrative_area_level_1')
      ? 'admin1'
      : types.includes('administrative_area_level_2')
        ? 'admin2'
        : types.includes('postal_code')
          ? 'postal_code'
          : types.some((t) => t.startsWith('sublocality') || t === 'neighborhood')
            ? 'district'
            : 'locality';

/** Google Geocoding API (optional): uses the `google_places` key (Geocoding API enabled). No polygons. */
@Injectable()
export class GoogleGeocoder implements Geocoder {
  readonly provider = 'google' as const;
  readonly perWorkspace = true;
  /** Google Maps Platform terms allow caching coordinates for at most 30 days. */
  readonly cacheDays = 30;

  constructor(private readonly secrets: SecretResolver) {}

  @WithResilience('geocoder')
  async geocode(query: GeocodeQuery): Promise<GeocodeResult[]> {
    const key = await this.secrets.resolve(query.orgId, 'google_places');
    if (!key) throw new ExternalServiceError('google-geocoding', 'no Google key configured');
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', query.text);
    url.searchParams.set('language', query.locale);
    if (query.countryHint) {
      url.searchParams.set('region', query.countryHint.toLowerCase());
      if (query.strictCountry) url.searchParams.set('components', `country:${query.countryHint}`);
    }
    url.searchParams.set('key', key.value);
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new ExternalServiceError('google-geocoding', `answered ${response.status}`);
    const parsed = GoogleResponse.safeParse(await response.json());
    if (!parsed.success) throw new ExternalServiceError('google-geocoding', 'unexpected response');
    if (parsed.data.status === 'OVER_QUERY_LIMIT')
      throw new RateLimitedError('Google geocoding quota reached.');
    // REQUEST_DENIED (bad or restricted key), INVALID_REQUEST, UNKNOWN_ERROR… are failures, not "no results":
    // caching them would hide every place for the cache lifetime.
    if (parsed.data.status !== 'OK' && parsed.data.status !== 'ZERO_RESULTS')
      throw new ExternalServiceError('google-geocoding', `status ${parsed.data.status}`);
    return parsed.data.results.map((r, index) => ({
      label: r.formatted_address,
      countryCode: r.address_components.find((c) => c.types.includes('country'))?.short_name ?? null,
      kind: googleKind(r.types),
      // No polygons from Google, and its terms forbid building a database from its results.
      persistable: false,
      center: r.geometry.location,
      bbox: r.geometry.viewport
        ? {
            west: r.geometry.viewport.southwest.lng,
            south: r.geometry.viewport.southwest.lat,
            east: r.geometry.viewport.northeast.lng,
            north: r.geometry.viewport.northeast.lat,
          }
        : null,
      geometry: null,
      sourceRef: `google:${r.place_id}`,
      importance: Math.max(0.3, 0.9 - index * 0.15),
    }));
  }
}
