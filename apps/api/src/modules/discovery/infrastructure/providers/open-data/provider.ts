import {
  type Clock,
  type OpenDataDataset,
  OpenDataSearchResponseSchema,
  type ProviderCapabilities,
  type ProviderCostModel,
  type ProviderLicensing,
  type ProviderQuery,
} from '@bf/contracts';
import type { IntelClient } from '../../../../platform/intel/intel-client.ts';
import type {
  BuildQueriesInput,
  ConnectionCheck,
  DiscoveryProvider,
  ProviderCallContext,
  ProviderCredential,
  ProviderFetchResult,
} from '../../../domain/provider.port.ts';
import { inTile, tileBounds } from '../../../domain/tile-geometry.ts';
import { openDataRecord } from './mapper.ts';

// Overture Maps Places and Foursquare OS Places through services/intel (BF-019, ADR-0002): DuckDB over the
// datasets' parquet with regional extracts cached in intel. Free; pages through all matches with a cursor.

const PAGE_LIMIT = 200;

/** Page tokens carry the release with the intel cursor: `release|cursor`. */
function splitToken(token: string): [string | undefined, string | undefined] {
  const at = token.indexOf('|');
  return at > 0 ? [token.slice(0, at), token.slice(at + 1)] : [undefined, token];
}
/** Enough pages for any tile we plan (200 × 50 places); a cursor keeps going if a tile is larger. */
const MAX_PAGES = 50;

const FREE: ProviderCostModel = {
  currency: 'USD',
  skus: [{ sku: 'open_data', label: 'Open-data query', perThousandUsd: 0, freeMonthlyCalls: 0 }],
  perResultUsd: null,
  notes: 'Open datasets queried in services/intel: no per-call cost.',
};

export const OVERTURE_LICENSING: ProviderLicensing = {
  retentionDays: null,
  storableFields: ['*'],
  attributionRequired: true,
  attributionText: 'Overture Maps Foundation (overturemaps.org)',
  commercialUseAllowed: true,
  reviewsUsage: 'none' as const,
  notes:
    'Licensed per source (record attributes.sources): Meta, Microsoft and others CDLA-Permissive-2.0 ("Data from ' +
    '[Name]. Available under CDLA Permissive 2.0."), Foursquare Apache-2.0, AllThePlaces CC0-1.0.',
};

export const FOURSQUARE_LICENSING: ProviderLicensing = {
  retentionDays: null,
  storableFields: ['*'],
  attributionRequired: true,
  attributionText: 'Foursquare OS Places — Copyright 2024 Foursquare Labs, Inc. (Apache-2.0)',
  commercialUseAllowed: true,
  reviewsUsage: 'none' as const,
  notes:
    'Apache-2.0: keep the licence and NOTICE with redistributed data. Gated on Hugging Face (token needed).',
};

export interface OpenDataProviderOptions {
  readonly dataset: OpenDataDataset;
  readonly intel: IntelClient;
  readonly clock: Clock;
  /** Pinned release for a workspace (Overture), or null for the latest. */
  readonly releaseFor?: (organizationId: string) => Promise<string | null>;
}

export class OpenDataProvider implements DiscoveryProvider {
  readonly id;
  readonly label;
  readonly secretName;
  readonly taxonomy;
  readonly featureFlag = null;
  readonly capabilities: ProviderCapabilities = {
    textQuery: false,
    categoryFilter: true,
    circle: true,
    bbox: true,
    polygon: true,
    maxResultsPerQuery: PAGE_LIMIT * MAX_PAGES,
    pagination: true,
  };
  readonly licensing: ProviderLicensing;
  readonly costModel = FREE;

  constructor(private readonly options: OpenDataProviderOptions) {
    const overture = options.dataset === 'overture';
    this.id = options.dataset;
    this.label = overture ? 'Overture Maps Places' : 'Foursquare OS Places';
    this.secretName = overture ? null : ('huggingface' as const);
    this.taxonomy = options.dataset;
    this.licensing = overture ? OVERTURE_LICENSING : FOURSQUARE_LICENSING;
  }

  buildQueries({ intent, tile, keysByCategory, fieldTier }: BuildQueriesInput): ProviderQuery[] {
    // Category keys only: these datasets have no text search (keyword-only intents go to other providers).
    return intent.categoryIds.flatMap((categoryId) => {
      const keys = keysByCategory.get(categoryId) ?? [];
      return keys.length === 0
        ? []
        : [
            {
              provider: this.id,
              categoryId,
              providerKeys: keys.slice(0, 100).map((k) => k.key),
              tile,
              languageCode: intent.languageCode,
              fieldTier,
              mode: 'search',
              pageNumber: 0,
            },
          ];
    });
  }

  skuFor(): string {
    return 'open_data';
  }

  maxPages(): number {
    return MAX_PAGES;
  }

  async fetchPage(query: ProviderQuery, context: ProviderCallContext): Promise<ProviderFetchResult> {
    // Later pages keep the first page's release (a cursor is only valid for its release).
    const [tokenRelease, cursor] = query.pageToken ? splitToken(query.pageToken) : [undefined, undefined];
    const release = tokenRelease ?? (await this.options.releaseFor?.(context.organizationId)) ?? undefined;
    const response = await this.options.intel.post(
      '/v1/open-data/places/search',
      {
        dataset: this.options.dataset,
        ...(release ? { release } : {}),
        geometry: { type: 'BBox', bbox: tileBounds(query.tile) },
        categories: query.providerKeys,
        limit: PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
        ...(context.credential ? { hfToken: context.credential.value } : {}),
      },
      OpenDataSearchResponseSchema,
      { policy: 'intel-open-data', signal: context.signal },
    );
    const fetchedAt = this.options.clock.now();
    const records = response.places
      .filter((place) => inTile(place.location, query.tile))
      .flatMap((place) => openDataRecord(this.options.dataset, response.release, place, fetchedAt) ?? []);
    // Open data pages through every match: a tile is never "saturated", the cursor continues.
    return {
      records,
      nextPageToken: response.nextCursor ? `${response.release}|${response.nextCursor}` : null,
      saturated: false,
      sku: 'open_data',
    };
  }

  /** Hugging Face token check (`whoami`); access to the gated dataset itself shows on the first query. */
  async testConnection(credential: ProviderCredential, signal: AbortSignal): Promise<ConnectionCheck> {
    const response = await fetch('https://huggingface.co/api/whoami-v2', {
      headers: { Authorization: `Bearer ${credential.value}` },
      signal,
    });
    if (response.status === 401) return { ok: false, message: 'Hugging Face rejected the token.' };
    if (!response.ok) return { ok: false, message: `Hugging Face answered ${response.status}.` };
    return {
      ok: true,
      message:
        'Token valid. Accept the Foursquare OS Places conditions on Hugging Face with this account to query it.',
    };
  }
}
