import {
  BudgetExceededError,
  type Clock,
  ForbiddenError,
  ProviderNotConfiguredError,
  type ProviderQuery,
  RateLimitedError,
} from '@bf/contracts';
import type { Logger } from '@bf/observability';
import type { IPolicy } from 'cockatiel';
import type { SecretResolver } from '../../workspace/index.ts';
import { billingScopeOf, type ProviderUsageMeter, type RateLimiter } from '../application/ports.ts';
import { skuOf } from '../domain/cost.ts';
import type {
  BuildQueriesInput,
  ConnectionCheck,
  DiscoveryProvider,
  ProviderCallContext,
  ProviderCredential,
  ProviderFetchResult,
} from '../domain/provider.port.ts';

export interface GuardOptions {
  readonly secrets: SecretResolver;
  readonly limiter: RateLimiter;
  readonly meter: ProviderUsageMeter;
  /** Builds a resilience policy; one per billing scope, so one account's failures don't trip others. */
  readonly policy: () => IPolicy;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Requests per second per key (null: no client-side limit, e.g. local fixtures). */
  readonly perSecond: number | null;
  /** The workspace's monthly provider budget (null: no cap). */
  readonly monthlyBudgetUsd: (organizationId: string) => Promise<number | null>;
}

/** Share of a shared (deployment) key one workspace may use, so one tenant cannot starve the others. */
export const SHARED_KEY_FAIR_SHARE = 0.5;

/** Providers whose every SKU is free never count against a budget. */
const isFree = (model: { readonly skus: ReadonlyArray<{ readonly perThousandUsd: number }> }) =>
  model.skus.every((sku) => sku.perThousandUsd === 0);

/**
 * Decorator around a provider's `fetchPage` (BF-018): resolves the credential (vault, then deployment key) →
 * checks the workspace's monthly budget → for every attempt, waits for rate-limit tokens (per key, plus a fair
 * share per workspace on the shared key) and calls through the resilience policy → meters the call (SKU,
 * results, cost after free allowances). Everything else delegates, so callers use it as the provider itself.
 */
export class GuardedProvider implements DiscoveryProvider {
  readonly id;
  readonly label;
  readonly secretName;
  readonly taxonomy;
  readonly featureFlag;
  readonly capabilities;
  readonly licensing;
  readonly costModel;

  constructor(
    private readonly inner: DiscoveryProvider,
    private readonly options: GuardOptions,
  ) {
    this.id = inner.id;
    this.label = inner.label;
    this.secretName = inner.secretName;
    this.taxonomy = inner.taxonomy;
    this.featureFlag = inner.featureFlag;
    this.capabilities = inner.capabilities;
    this.licensing = inner.licensing;
    this.costModel = inner.costModel;
  }

  buildQueries(input: BuildQueriesInput): ProviderQuery[] {
    return this.inner.buildQueries(input);
  }

  skuFor(query: ProviderQuery): string {
    return this.inner.skuFor(query);
  }

  maxPages(query: ProviderQuery): number {
    return this.inner.maxPages(query);
  }

  testConnection(credential: ProviderCredential, signal: AbortSignal): Promise<ConnectionCheck> {
    return this.inner.testConnection(credential, signal);
  }

  async isAllowed(organizationId: string): Promise<boolean> {
    return this.inner.isAllowed ? this.inner.isAllowed(organizationId) : true;
  }

  async fetchPage(query: ProviderQuery, context: ProviderCallContext): Promise<ProviderFetchResult> {
    // Gated providers (the scraper) are refused here too, not only by selection.
    if (this.inner.isAllowed && !(await this.inner.isAllowed(context.organizationId))) {
      throw new ForbiddenError(`${this.label} is not enabled for this workspace.`, {
        details: { reason: 'PROVIDER_NOT_ALLOWED' },
      });
    }
    const credential = await this.credentialFor(context.organizationId);
    const scope = billingScopeOf(context.organizationId, credential?.source ?? null);
    await this.assertWithinBudget(context.organizationId);
    // Every attempt (retries included) takes tokens, so a failure burst cannot exceed the per-key rate.
    const result = await this.policyFor(scope).execute(async ({ signal }) => {
      await this.takeTokens(context.organizationId, scope, signal);
      return this.inner.fetchPage(query, { ...context, credential, signal });
    }, context.signal);
    const callCostUsd = await this.meter(context.organizationId, scope, result);
    return { ...result, callCostUsd };
  }

  private readonly policies = new Map<string, IPolicy>();

  private policyFor(scope: string): IPolicy {
    let policy = this.policies.get(scope);
    if (!policy) {
      policy = this.options.policy();
      this.policies.set(scope, policy);
    }
    return policy;
  }

  private async takeTokens(organizationId: string, scope: string, signal: AbortSignal): Promise<void> {
    const perSecond = this.options.perSecond;
    if (perSecond === null) return;
    const buckets = [{ key: `${this.id}:${scope}`, perSecond }];
    if (scope === 'global') {
      buckets.push({
        key: `${this.id}:global:${organizationId}`,
        perSecond: perSecond * SHARED_KEY_FAIR_SHARE,
      });
    }
    for (const bucket of buckets) {
      const limit = { capacity: Math.max(1, Math.ceil(bucket.perSecond)), perSecond: bucket.perSecond };
      if (!(await this.options.limiter.acquire(bucket.key, limit, signal))) {
        // Our own limiter already waited: retrying would only queue again.
        throw new RateLimitedError(`${this.label} is busy, try again shortly.`, undefined, {
          details: { retryable: false },
        });
      }
    }
  }

  /** Hard stop at the workspace's monthly budget (runs budget themselves too, BF-020). */
  private async assertWithinBudget(organizationId: string): Promise<void> {
    if (isFree(this.costModel)) return;
    const budget = await this.options.monthlyBudgetUsd(organizationId);
    if (budget === null) return;
    const spent = await this.options.meter.monthCostUsd(organizationId, this.options.clock.now());
    if (spent >= budget) {
      throw new BudgetExceededError('The workspace monthly provider budget is spent.', {
        details: { reason: 'MONTHLY_PROVIDER_BUDGET' },
      });
    }
  }

  /** Records the call; a metering failure is logged, never allowed to lose a page already paid for. */
  private async meter(organizationId: string, scope: string, result: ProviderFetchResult): Promise<number> {
    try {
      return await this.options.meter.record(
        {
          organizationId,
          provider: this.id,
          sku: result.sku,
          billingScope: scope,
          calls: 1,
          results: result.records.length,
          at: this.options.clock.now(),
        },
        skuOf(this.costModel, result.sku) ?? null,
      );
    } catch (error) {
      this.options.logger.error(
        { err: error, provider: this.id, sku: result.sku },
        'provider usage not recorded',
      );
      return 0;
    }
  }

  private async credentialFor(organizationId: string): Promise<ProviderCredential | null> {
    if (!this.secretName) return null;
    const secret = await this.options.secrets.resolve(organizationId, this.secretName);
    if (!secret) throw new ProviderNotConfiguredError(this.label, this.secretName);
    return { value: secret.value, source: secret.source };
  }
}
