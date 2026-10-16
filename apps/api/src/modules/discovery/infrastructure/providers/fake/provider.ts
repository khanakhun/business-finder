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
    reviewsUsage: 'none' as const,
    notes: 'Fictional fixture data for tests and E2E.',
  };
  readonly costModel;

  /** `synthetic`: generated records on a fixed grid (benchmarks, adaptive-tiling tests) instead of fixtures. */
  constructor(
    private readonly clock: Clock,
    private readonly synthetic = false,
  ) {
    // Synthetic calls cost $1 each, so budget stops can be tested end to end; fixtures are free.
    this.costModel = {
      currency: 'USD' as const,
      skus: [
        { sku: 'fixture', label: 'Fixture call', perThousandUsd: synthetic ? 1_000 : 0, freeMonthlyCalls: 0 },
      ],
      perResultUsd: null,
      notes: synthetic ? 'Synthetic test calls: $1 each.' : 'No cost.',
    };
  }

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
    if (this.synthetic) return this.syntheticPage(query);
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

  /**
   * Grid points (every 0.005°, ~550 m) inside the tile: overlapping tiles return the same points (stable refs),
   * and dense tiles saturate at 20 like a capped provider.
   */
  private syntheticPage(query: ProviderQuery): ProviderFetchResult {
    const step = 0.005;
    const box =
      query.tile.type === 'BBox'
        ? query.tile.bbox
        : {
            west: query.tile.center.lng - query.tile.radiusM / 100_000,
            east: query.tile.center.lng + query.tile.radiusM / 100_000,
            south: query.tile.center.lat - query.tile.radiusM / 100_000,
            north: query.tile.center.lat + query.tile.radiusM / 100_000,
          };
    const key = query.providerKeys[0] ?? 'establishment';
    const points: Array<{ lat: number; lng: number; id: string }> = [];
    for (let i = Math.ceil(box.south / step); i * step <= box.north; i++) {
      for (let j = Math.ceil(box.west / step); j * step <= box.east; j++) {
        const location = { lat: Number((i * step).toFixed(6)), lng: Number((j * step).toFixed(6)) };
        if (inTile(location, query.tile)) points.push({ ...location, id: `${key}:${i}:${j}` });
      }
    }
    const fetchedAt = this.clock.now().toISOString();
    return {
      records: points.slice(0, MAX_RESULTS).map((p) => ({
        provider: 'import' as const,
        providerRef: `fake:syn:${p.id}`,
        fetchedAt,
        name: `Entreprise synthétique ${p.id}`,
        providerCategories: [{ key }],
        location: { lat: p.lat, lng: p.lng },
        address: { city: 'Gustavia', countryCode: 'BL' },
        phones: [],
        emails: [],
        socials: [],
      })),
      nextPageToken: null,
      saturated: points.length >= MAX_RESULTS,
      sku: 'fixture',
    };
  }

  async testConnection(): Promise<ConnectionCheck> {
    return { ok: true, message: 'Fixture provider (no network).' };
  }
}
