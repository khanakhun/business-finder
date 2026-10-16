import type { BBox, Clock, ProviderCapabilities, ProviderQuery } from '@bf/contracts';
import type {
  BuildQueriesInput,
  ConnectionCheck,
  DiscoveryProvider,
  ProviderCallContext,
  ProviderCredential,
  ProviderFetchResult,
  ProviderKey,
} from '../../../domain/provider.port.ts';
import { GooglePlacesClient, type SearchResponse } from './client.ts';
import { effectiveTier, fieldMask, type GoogleEndpoint, ID_ONLY_TEXT_MASK, skuFor } from './field-masks.ts';
import { GOOGLE_PLACES_COST_MODEL, GOOGLE_PLACES_LICENSING } from './licensing.ts';
import { toSourceRecord } from './mapper.ts';

/** Text Search: 20 results per page, 60 across pages. Nearby Search: 20, no pages (README). */
const PAGE_SIZE = 20;
const TEXT_MAX_RESULTS = 60;
const NEARBY_MAX_RESULTS = 20;
/** Nearby Search accepts at most 50 types per list. */
const MAX_TYPES = 50;
const MAX_RADIUS_M = 50_000;

const KM_PER_DEGREE_LAT = 110.574;

/** The rectangle enclosing a circle (Text Search restricts to rectangles only). */
function circleBounds(center: { lat: number; lng: number }, radiusM: number): BBox {
  const dLat = radiusM / 1000 / KM_PER_DEGREE_LAT;
  const dLng = radiusM / 1000 / (111.32 * Math.max(0.01, Math.cos((center.lat * Math.PI) / 180)));
  return {
    west: Math.max(-180, center.lng - dLng),
    south: Math.max(-90, center.lat - dLat),
    east: Math.min(180, center.lng + dLng),
    north: Math.min(90, center.lat + dLat),
  };
}

const rectangle = (box: BBox) => ({
  rectangle: {
    low: { latitude: box.south, longitude: box.west },
    high: { latitude: box.north, longitude: box.east },
  },
});

function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

const phrase = (key: ProviderKey) => key.label ?? key.key.replace(/_/g, ' ');

/**
 * Google Places API (New) provider: Text Search for keywords and box tiles (rectangle restriction, 3 pages of
 * 20), Nearby Search for category-only circle tiles (20 nearest, no pages — a full answer marks the tile
 * saturated so the planner splits it). Field masks follow the workspace tier; records expire per the licence.
 */
export class GooglePlacesProvider implements DiscoveryProvider {
  readonly id = 'google_places' as const;
  readonly label = 'Google Places';
  readonly secretName = 'google_places' as const;
  readonly taxonomy = 'google_places' as const;
  readonly featureFlag = null;
  readonly capabilities: ProviderCapabilities = {
    textQuery: true,
    categoryFilter: true,
    circle: true,
    bbox: true,
    polygon: false,
    maxResultsPerQuery: TEXT_MAX_RESULTS,
    pagination: true,
  };
  readonly licensing = GOOGLE_PLACES_LICENSING;
  readonly costModel = GOOGLE_PLACES_COST_MODEL;

  constructor(
    private readonly clock: Clock,
    private readonly client = new GooglePlacesClient(),
  ) {}

  buildQueries({ intent, tile, keysByCategory, fieldTier }: BuildQueriesInput): ProviderQuery[] {
    const base = {
      provider: this.id,
      tile,
      languageCode: intent.languageCode,
      ...(intent.regionCode ? { regionCode: intent.regionCode } : {}),
      fieldTier,
      pageNumber: 0,
    };
    const queries: ProviderQuery[] = [];
    for (const categoryId of intent.categoryIds) {
      const keys = keysByCategory.get(categoryId) ?? [];
      if (keys.length === 0) continue;
      if (tile.type === 'Circle' && !intent.keywords && tile.radiusM <= MAX_RADIUS_M) {
        // One Nearby call covers every type of the category.
        queries.push({
          ...base,
          categoryId,
          providerKeys: keys.slice(0, MAX_TYPES).map((k) => k.key),
          mode: 'nearby',
        });
        continue;
      }
      // Text Search takes one type per call.
      for (const key of keys) {
        queries.push({
          ...base,
          categoryId,
          providerKeys: [key.key],
          keywords: intent.keywords ?? phrase(key),
          mode: 'text',
        });
      }
    }
    // Keywords alone (or categories Google has no type for) still search by text.
    if (queries.length === 0 && intent.keywords) {
      queries.push({ ...base, categoryId: null, providerKeys: [], keywords: intent.keywords, mode: 'text' });
    }
    return queries;
  }

  skuFor(query: ProviderQuery): string {
    return skuFor(query.mode as GoogleEndpoint, query.fieldTier);
  }

  maxPages(query: ProviderQuery): number {
    return query.mode === 'nearby' ? 1 : TEXT_MAX_RESULTS / PAGE_SIZE;
  }

  async fetchPage(query: ProviderQuery, context: ProviderCallContext): Promise<ProviderFetchResult> {
    if (!context.credential) throw new Error('GooglePlacesProvider called without a credential');
    const endpoint: GoogleEndpoint = query.mode === 'nearby' ? 'nearby' : 'text';
    const mask = fieldMask(endpoint, query.fieldTier);
    const response =
      endpoint === 'nearby'
        ? await this.client.searchNearby(
            this.nearbyBody(query),
            mask,
            context.credential.value,
            context.signal,
          )
        : await this.client.searchText(this.textBody(query), mask, context.credential.value, context.signal);
    return this.toResult(endpoint, query, response);
  }

  async testConnection(credential: ProviderCredential, signal: AbortSignal): Promise<ConnectionCheck> {
    // IDs-only Text Search: no charge, proves the key and the API are enabled.
    const response = await this.client.searchText(
      { textQuery: 'cafe', pageSize: 1 },
      ID_ONLY_TEXT_MASK,
      credential.value,
      signal,
    );
    return { ok: true, message: `Google Places answered (${response.places.length} result).` };
  }

  private textBody(query: ProviderQuery) {
    const box =
      query.tile.type === 'BBox' ? query.tile.bbox : circleBounds(query.tile.center, query.tile.radiusM);
    const [type] = query.providerKeys;
    return {
      textQuery: query.keywords ?? type?.replace(/_/g, ' ') ?? '',
      ...(type ? { includedType: type, strictTypeFiltering: true } : {}),
      languageCode: query.languageCode,
      ...(query.regionCode ? { regionCode: query.regionCode } : {}),
      pageSize: PAGE_SIZE,
      ...(query.pageToken ? { pageToken: query.pageToken } : {}),
      locationRestriction: rectangle(box),
    };
  }

  private nearbyBody(query: ProviderQuery) {
    if (query.tile.type !== 'Circle') throw new Error('Nearby Search needs a circle tile');
    return {
      includedTypes: query.providerKeys.slice(0, MAX_TYPES),
      maxResultCount: NEARBY_MAX_RESULTS,
      rankPreference: 'DISTANCE',
      languageCode: query.languageCode,
      ...(query.regionCode ? { regionCode: query.regionCode } : {}),
      locationRestriction: {
        circle: {
          center: { latitude: query.tile.center.lat, longitude: query.tile.center.lng },
          radius: Math.min(MAX_RADIUS_M, query.tile.radiusM),
        },
      },
    };
  }

  private toResult(
    endpoint: GoogleEndpoint,
    query: ProviderQuery,
    response: SearchResponse,
  ): ProviderFetchResult {
    const fetchedAt = this.clock.now();
    const all = response.places.flatMap((place) => toSourceRecord(place, fetchedAt) ?? []);
    // Text Search restricts circles to their enclosing rectangle: drop the corners outside the circle.
    const tile = query.tile;
    const records =
      tile.type === 'Circle'
        ? all.filter((r) => !r.location || distanceM(r.location, tile.center) <= tile.radiusM)
        : all;
    // An absent or empty token means there are no more pages.
    const nextPageToken = endpoint === 'text' ? response.nextPageToken || null : null;
    const full = response.places.length >= (endpoint === 'nearby' ? NEARBY_MAX_RESULTS : PAGE_SIZE);
    // Saturated: the provider stopped at its maximum, so more businesses may exist in the tile.
    const lastTextPage = (query.pageNumber + 1) * PAGE_SIZE >= TEXT_MAX_RESULTS;
    const saturated = full && (endpoint === 'nearby' || (lastTextPage && nextPageToken === null));
    return { records, nextPageToken, saturated, sku: skuFor(endpoint, effectiveTier(query.fieldTier)) };
  }
}
