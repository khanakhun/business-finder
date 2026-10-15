import type {
  DiscoveryIntent,
  DiscoveryTile,
  FeatureFlag,
  FieldTier,
  ProviderCapabilities,
  ProviderCostModel,
  ProviderId,
  ProviderLicensing,
  ProviderQuery,
  SecretName,
  SourceRecordInput,
  TaxonomyProvider,
} from '@bf/contracts';

// The provider port (BF-018, ADR-0013): every discovery source implements it, so orchestration (BF-020) never
// changes when a provider is added. Rate limiting, resilience and metering wrap `fetchPage` (Decorator).

/** A provider category key with the label used to phrase text queries. */
export interface ProviderKey {
  readonly key: string;
  readonly label: string | null;
}

export interface BuildQueriesInput {
  readonly intent: DiscoveryIntent;
  readonly tile: DiscoveryTile;
  /** Provider keys per requested taxonomy category (from category mappings, BF-015). */
  readonly keysByCategory: ReadonlyMap<string, readonly ProviderKey[]>;
  readonly fieldTier: FieldTier;
}

/** The credential resolved for this call (workspace vault or deployment fallback). */
export interface ProviderCredential {
  readonly value: string;
  readonly source: 'workspace' | 'global';
}

export interface ProviderCallContext {
  readonly organizationId: string;
  readonly credential: ProviderCredential | null;
  readonly signal: AbortSignal;
}

/** One page as the provider returned it (the metering decorator adds its cost). */
export interface ProviderFetchResult {
  readonly records: readonly SourceRecordInput[];
  readonly nextPageToken: string | null;
  readonly saturated: boolean;
  readonly sku: string;
  /** Set by the metering decorator: the call's cost after free monthly allowances. */
  readonly callCostUsd?: number;
}

export interface ConnectionCheck {
  readonly ok: boolean;
  readonly message?: string;
}

export interface DiscoveryProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** Vault secret the provider needs, or null for keyless sources. */
  readonly secretName: SecretName | null;
  /** Whose category keys the provider understands (category mappings provider), or null for keyword-only. */
  readonly taxonomy: TaxonomyProvider | null;
  /** Workspace feature flag that must be on for the provider to be used (e.g. the scraper), if any. */
  readonly featureFlag: FeatureFlag | null;
  readonly capabilities: ProviderCapabilities;
  readonly licensing: ProviderLicensing;
  readonly costModel: ProviderCostModel;
  buildQueries(input: BuildQueriesInput): ProviderQuery[];
  /** The SKU a query bills (for estimates before any call). */
  skuFor(query: ProviderQuery): string;
  /** Most calls (pages) one query can take: Text Search 3, Nearby 1. */
  maxPages(query: ProviderQuery): number;
  /**
   * One page. Callers pass `pageNumber` (0-based) and the previous `nextPageToken`: saturation is judged on the
   * provider's last possible page.
   */
  fetchPage(query: ProviderQuery, context: ProviderCallContext): Promise<ProviderFetchResult>;
  /** A cheap call proving the credential works (Settings → Integrations). */
  testConnection(credential: ProviderCredential, signal: AbortSignal): Promise<ConnectionCheck>;
}
