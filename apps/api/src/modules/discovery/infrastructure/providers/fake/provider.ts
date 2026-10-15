import { readFileSync } from 'node:fs';
import type { Clock, DiscoveryTile, ProviderQuery, SourceRecordInput } from '@bf/contracts';
import type {
  BuildQueriesInput,
  ConnectionCheck,
  DiscoveryProvider,
  ProviderCallContext,
  ProviderFetchResult,
} from '../../../domain/provider.port.ts';

// Fixture provider for tests and E2E (BF-018, used by BF-023): fictional Saint-Barthélemy businesses, no network.
// Registered only when NODE_ENV=test or FAKE_DISCOVERY_PROVIDER=true, never in production.

type Fixture = Omit<SourceRecordInput, 'provider' | 'fetchedAt'>;

const FIXTURES: readonly Fixture[] = JSON.parse(
  readFileSync(new URL('./fixtures/bl.json', import.meta.url), 'utf8'),
) as Fixture[];
const MAX_RESULTS = 20;

function inTile(location: { lat: number; lng: number } | undefined, tile: DiscoveryTile): boolean {
  if (!location) return false;
  if (tile.type === 'BBox') {
    const { west, south, east, north } = tile.bbox;
    return location.lat >= south && location.lat <= north && location.lng >= west && location.lng <= east;
  }
  const dLat = ((location.lat - tile.center.lat) * Math.PI) / 180;
  const dLng = ((location.lng - tile.center.lng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((tile.center.lat * Math.PI) / 180) *
      Math.cos((location.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(a)) <= tile.radiusM;
}

export class FakeDiscoveryProvider implements DiscoveryProvider {
  readonly id = 'fake' as const;
  readonly label = 'Fixtures (test only)';
  readonly secretName = null;
  readonly taxonomy = 'google_places' as const;
  readonly featureFlag = null;
  readonly capabilities = {
    textQuery: true,
    categoryFilter: true,
    circle: true,
    bbox: true,
    polygon: false,
    maxResultsPerQuery: MAX_RESULTS,
    pagination: false,
  };
  readonly licensing = {
    retentionDays: null,
    storableFields: ['*'],
    attributionRequired: false,
    attributionText: null,
    commercialUseAllowed: true,
    notes: 'Fictional fixture data for tests and E2E.',
  };
  readonly costModel = {
    currency: 'USD' as const,
    skus: [{ sku: 'fixture', label: 'Fixture call', perThousandUsd: 0, freeMonthlyCalls: 0 }],
    perResultUsd: null,
    notes: 'No cost.',
  };

  constructor(private readonly clock: Clock) {}

  buildQueries({ intent, tile, keysByCategory, fieldTier }: BuildQueriesInput): ProviderQuery[] {
    const base = {
      provider: this.id,
      tile,
      languageCode: intent.languageCode,
      fieldTier,
      mode: 'search',
      pageNumber: 0,
    };
    const queries: ProviderQuery[] = intent.categoryIds.flatMap((categoryId) => {
      const keys = keysByCategory.get(categoryId) ?? [];
      return keys.length === 0
        ? []
        : [
            {
              ...base,
              categoryId,
              providerKeys: keys.map((k) => k.key),
              ...(intent.keywords ? { keywords: intent.keywords } : {}),
            },
          ];
    });
    if (queries.length === 0 && intent.keywords) {
      queries.push({ ...base, categoryId: null, providerKeys: [], keywords: intent.keywords });
    }
    return queries;
  }

  skuFor(): string {
    return 'fixture';
  }

  maxPages(): number {
    return 1;
  }

  async fetchPage(query: ProviderQuery, _context: ProviderCallContext): Promise<ProviderFetchResult> {
    const words = (query.keywords ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const matches = FIXTURES.filter(
      (f) =>
        inTile(f.location, query.tile) &&
        (query.providerKeys.length === 0 ||
          (f.providerCategories ?? []).some((c) => query.providerKeys.includes(c.key))) &&
        (query.providerKeys.length > 0 || words.some((w) => f.name.toLowerCase().includes(w))),
    );
    const fetchedAt = this.clock.now().toISOString();
    return {
      records: matches.slice(0, MAX_RESULTS).map((f) => ({ ...f, provider: 'import', fetchedAt })),
      nextPageToken: null,
      saturated: matches.length >= MAX_RESULTS,
      sku: 'fixture',
    };
  }

  async testConnection(): Promise<ConnectionCheck> {
    return { ok: true, message: 'Fixture provider (no network).' };
  }
}
