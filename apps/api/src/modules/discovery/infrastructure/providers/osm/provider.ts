import { type Clock, ExternalServiceError, type ProviderQuery, RateLimitedError } from '@bf/contracts';
import { z } from 'zod';
import type {
  BuildQueriesInput,
  ConnectionCheck,
  DiscoveryProvider,
  ProviderCallContext,
  ProviderFetchResult,
} from '../../../domain/provider.port.ts';
import { osmRecord } from './mapper.ts';
import { overpassQuery, tagFilter } from './overpass.ts';

// OpenStreetMap via Overpass (BF-019): named elements carrying the category's tags in the tile. Usage policy:
// identifying User-Agent, no parallel queries, back off on 429 (the guard's rate limit and retries apply).

const RESULT_LIMIT = 500;
const TIMEOUT_S = 25;

const OverpassResponse = z.object({
  remark: z.string().optional(),
  elements: z
    .array(
      z.object({
        type: z.enum(['node', 'way', 'relation']),
        id: z.number(),
        lat: z.number().optional(),
        lon: z.number().optional(),
        center: z.object({ lat: z.number(), lon: z.number() }).optional(),
        tags: z.record(z.string(), z.string()).optional(),
      }),
    )
    .default([]),
});

export const OSM_LICENSING = {
  retentionDays: null,
  storableFields: ['*'],
  attributionRequired: true,
  attributionText: '© OpenStreetMap contributors',
  commercialUseAllowed: true,
  reviewsUsage: 'none' as const,
  notes:
    'ODbL 1.0: attribute "© OpenStreetMap contributors" linking to openstreetmap.org/copyright; derived ' +
    'databases that are published stay under the ODbL.',
};

export interface OsmProviderOptions {
  readonly clock: Clock;
  readonly endpoint: string;
  readonly contactEmail?: string | undefined;
}

export class OsmOverpassProvider implements DiscoveryProvider {
  readonly id = 'osm' as const;
  readonly label = 'OpenStreetMap';
  readonly secretName = null;
  readonly taxonomy = 'osm' as const;
  readonly featureFlag = null;
  readonly capabilities = {
    textQuery: false,
    categoryFilter: true,
    circle: true,
    bbox: true,
    polygon: false,
    maxResultsPerQuery: RESULT_LIMIT,
    pagination: false,
  };
  readonly licensing = OSM_LICENSING;
  readonly costModel = {
    currency: 'USD' as const,
    skus: [{ sku: 'overpass', label: 'Overpass query', perThousandUsd: 0, freeMonthlyCalls: 0 }],
    perResultUsd: null,
    notes: 'No charge; public instances limit volume (self-host for regular use).',
  };

  constructor(private readonly options: OsmProviderOptions) {}

  buildQueries({ intent, tile, keysByCategory, fieldTier }: BuildQueriesInput): ProviderQuery[] {
    return intent.categoryIds.flatMap((categoryId) => {
      const tags = (keysByCategory.get(categoryId) ?? [])
        .map((k) => k.key)
        .filter((k) => tagFilter(k) !== null);
      return tags.length === 0
        ? []
        : [
            {
              provider: this.id,
              categoryId,
              providerKeys: tags.slice(0, 30),
              tile,
              languageCode: intent.languageCode,
              fieldTier,
              mode: 'overpass',
              pageNumber: 0,
            },
          ];
    });
  }

  skuFor(): string {
    return 'overpass';
  }

  maxPages(): number {
    return 1;
  }

  async fetchPage(query: ProviderQuery, context: ProviderCallContext): Promise<ProviderFetchResult> {
    const body = new URLSearchParams({
      data: overpassQuery(query.providerKeys, query.tile, RESULT_LIMIT, TIMEOUT_S),
    });
    const response = await fetch(this.options.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': `BusinessFinder/0.1 (+https://github.com/khanakhun/business-finder)${
          this.options.contactEmail ? ` ${this.options.contactEmail}` : ''
        }`,
        Accept: 'application/json',
      },
      body,
      signal: AbortSignal.any([context.signal, AbortSignal.timeout((TIMEOUT_S + 10) * 1000)]),
    });
    // Policy: wait 30 s after a 429.
    if (response.status === 429) throw new RateLimitedError('Overpass rate limit reached.', 30);
    if (!response.ok) {
      throw new ExternalServiceError('overpass', `answered ${response.status}`, {
        details: { retryable: response.status >= 500 || response.status === 504 },
      });
    }
    const parsed = OverpassResponse.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new ExternalServiceError('overpass', 'unexpected response');
    // A 200 with a runtime-error remark carries partial (or no) elements: retry rather than ingest a gap.
    if (parsed.data.remark && /error|timed out|out of memory/i.test(parsed.data.remark)) {
      throw new ExternalServiceError('overpass', 'query did not complete', { details: { retryable: true } });
    }
    const fetchedAt = this.options.clock.now();
    const records = parsed.data.elements.flatMap((element) => osmRecord(element, fetchedAt) ?? []);
    return {
      records,
      nextPageToken: null,
      saturated: parsed.data.elements.length >= RESULT_LIMIT,
      sku: 'overpass',
    };
  }

  async testConnection(): Promise<ConnectionCheck> {
    return { ok: true };
  }
}
