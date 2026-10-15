import type { ProviderId, ProviderUsageRow, TaxonomyProvider } from '@bf/contracts';
import type { ProviderKey } from '../domain/provider.port.ts';

// Discovery ports (BF-018).

/** Category → provider keys, from active category mappings (BF-015), including descendant categories. */
export interface CategoryProviderKeys {
  keysFor(categoryIds: readonly string[], taxonomy: TaxonomyProvider): Promise<Map<string, ProviderKey[]>>;
}
export const CATEGORY_PROVIDER_KEYS = Symbol('CategoryProviderKeys');

export interface UsageEvent {
  readonly organizationId: string;
  readonly provider: ProviderId;
  readonly sku: string;
  /** Whose account pays: the workspace id (own key) or `global` (deployment key). */
  readonly billingScope: string;
  readonly calls: number;
  readonly results: number;
  readonly at: Date;
}

/** `provider_usage`: records calls with their cost after free allowances, and reports usage. */
export interface ProviderUsageMeter {
  /** Records the call and returns its cost (0 within the billing account's free monthly allowance). */
  record(
    event: UsageEvent,
    price: { perThousandUsd: number; freeMonthlyCalls: number } | null,
  ): Promise<number>;
  /** Calls this calendar month (UTC) on a billing account, per SKU of a provider. */
  monthCalls(billingScope: string, provider: ProviderId, at: Date): Promise<Map<string, number>>;
  /** The workspace's provider spend this calendar month (UTC). */
  monthCostUsd(organizationId: string, at: Date): Promise<number>;
  report(organizationId: string, from: string, to: string): Promise<ProviderUsageRow[]>;
}
export const PROVIDER_USAGE_METER = Symbol('ProviderUsageMeter');

// Token buckets are shared with other modules (enrichment steps): defined in platform.
export { RATE_LIMITER, type RateLimiter } from '../../platform/rate-limit/valkey-rate-limiter.ts';

export const billingScopeOf = (organizationId: string, source: 'workspace' | 'global' | null) =>
  source === 'workspace' ? organizationId : 'global';
