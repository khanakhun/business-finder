import {
  type Clock,
  type DiscoveryIntent,
  type DiscoveryProviderList,
  type DiscoveryTile,
  type FieldTier,
  NotFoundError,
  type ProviderId,
  type ProviderQuery,
  type ProviderUsageQuery,
  type ProviderUsageReport,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { APP_ENV, type AppEnv } from '../../platform/config/app-env.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { FeatureFlagService, SecretResolver, WorkspaceDefaults } from '../../workspace/index.ts';
import { type CostEstimate, estimateCost } from '../domain/cost.ts';
import type { DiscoveryProvider } from '../domain/provider.port.ts';
import { type ProviderCandidate, type SelectionResult, selectProviders } from '../domain/selection-policy.ts';
import {
  billingScopeOf,
  CATEGORY_PROVIDER_KEYS,
  type CategoryProviderKeys,
  PROVIDER_USAGE_METER,
  type ProviderUsageMeter,
} from './ports.ts';
import { ProviderRegistry } from './provider-registry.ts';

const workspaceOf = (auth: AuthContext): string => {
  if (!auth.orgId) throw new Error('Discovery route reached without an active workspace');
  return auth.orgId;
};

/** Builds a provider's queries for an intent and tile, resolving category keys from the mappings (BF-015). */
@Injectable()
export class ProviderQueryBuilder {
  constructor(
    private readonly registry: ProviderRegistry,
    @Inject(CATEGORY_PROVIDER_KEYS) private readonly keys: CategoryProviderKeys,
    private readonly defaults: WorkspaceDefaults,
  ) {}

  async build(
    organizationId: string,
    providerId: ProviderId,
    intent: DiscoveryIntent,
    tile: DiscoveryTile,
    fieldTier?: FieldTier,
  ): Promise<ProviderQuery[]> {
    const provider = this.provider(providerId);
    const keysByCategory =
      provider.taxonomy && intent.categoryIds.length > 0
        ? await this.keys.keysFor(intent.categoryIds, provider.taxonomy)
        : new Map();
    const tier = fieldTier ?? (await this.defaults.discoverySettings(organizationId)).googleFieldTier;
    return provider.buildQueries({ intent, tile, keysByCategory, fieldTier: tier });
  }

  private provider(id: ProviderId): DiscoveryProvider {
    const provider = this.registry.get(id);
    if (!provider) throw new NotFoundError('DiscoveryProvider', id);
    return provider;
  }
}

/** Cost of planned queries (pages per query given), after the billing account's free monthly allowances. */
@Injectable()
export class ProviderCostEstimator {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly secrets: SecretResolver,
    @Inject(PROVIDER_USAGE_METER) private readonly meter: ProviderUsageMeter,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async estimate(
    organizationId: string,
    providerId: ProviderId,
    queries: readonly ProviderQuery[],
    pagesPerQuery = 1,
  ): Promise<CostEstimate> {
    const provider = this.registry.get(providerId);
    if (!provider) throw new NotFoundError('DiscoveryProvider', providerId);
    const secret = provider.secretName
      ? await this.secrets.resolve(organizationId, provider.secretName)
      : undefined;
    const scope = billingScopeOf(organizationId, secret?.source ?? null);
    const used = await this.meter.monthCalls(scope, providerId, this.clock.now());
    const planned = queries.map((q) => ({
      sku: provider.skuFor(q),
      calls: Math.min(pagesPerQuery, provider.maxPages(q)),
    }));
    return estimateCost(provider.costModel, planned, used, this.env.DISCOVERY_APPLY_FREE_TIER);
  }
}

/** Which providers serve an intent for a workspace (preference order, settings, secrets, budget). */
@Injectable()
export class ProviderSelectionService {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly flags: FeatureFlagService,
    private readonly secrets: SecretResolver,
    private readonly defaults: WorkspaceDefaults,
    @Inject(PROVIDER_USAGE_METER) private readonly meter: ProviderUsageMeter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async candidates(organizationId: string, estimatedCostUsd: ReadonlyMap<ProviderId, number> = new Map()) {
    const settings = await this.defaults.discoverySettings(organizationId);
    const candidates: ProviderCandidate[] = await Promise.all(
      this.registry.all().map(async (provider) => ({
        id: provider.id,
        capabilities: provider.capabilities,
        available: provider.featureFlag
          ? await this.flags.isEnabled(organizationId, provider.featureFlag)
          : true,
        enabled: !settings.disabledProviders.includes(provider.id),
        configured:
          !provider.secretName ||
          (await this.secrets.resolve(organizationId, provider.secretName)) !== undefined,
        estimatedCostUsd: estimatedCostUsd.get(provider.id) ?? 0,
      })),
    );
    return { settings, candidates };
  }

  async select(
    organizationId: string,
    needs: { readonly keywords: boolean; readonly categories: boolean; readonly tile: DiscoveryTile['type'] },
    estimatedCostUsd: ReadonlyMap<ProviderId, number> = new Map(),
  ): Promise<SelectionResult> {
    const { settings, candidates } = await this.candidates(organizationId, estimatedCostUsd);
    const budgetRemainingUsd =
      settings.monthlyBudgetUsd === null
        ? null
        : Math.max(
            0,
            settings.monthlyBudgetUsd - (await this.meter.monthCostUsd(organizationId, this.clock.now())),
          );
    return selectProviders({
      needs,
      preferenceOrder: settings.providerOrder,
      candidates,
      budgetRemainingUsd,
    });
  }
}

/** `GET /v1/discovery/providers` and `GET /v1/discovery/usage`. */
@Injectable()
export class DiscoveryQueries {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly selection: ProviderSelectionService,
    @Inject(PROVIDER_USAGE_METER) private readonly meter: ProviderUsageMeter,
  ) {}

  async providers(auth: AuthContext): Promise<DiscoveryProviderList> {
    const { settings, candidates } = await this.selection.candidates(workspaceOf(auth));
    const rank = (id: ProviderId) => {
      const index = settings.providerOrder.indexOf(id);
      return index === -1 ? settings.providerOrder.length : index;
    };
    const items = this.registry
      .all()
      .map((provider) => {
        const candidate = candidates.find((c) => c.id === provider.id);
        const status = !candidate?.available
          ? ('unavailable' as const)
          : !candidate.enabled
            ? ('disabled' as const)
            : !candidate.configured
              ? ('not_configured' as const)
              : ('ready' as const);
        return {
          id: provider.id,
          label: provider.label,
          status,
          secretName: provider.secretName,
          preferenceRank: rank(provider.id),
          capabilities: provider.capabilities,
          licensing: provider.licensing,
          costModel: provider.costModel,
        };
      })
      .sort((a, b) => a.preferenceRank - b.preferenceRank || a.id.localeCompare(b.id));
    return { items };
  }

  async usage(auth: AuthContext, query: ProviderUsageQuery): Promise<ProviderUsageReport> {
    const rows = await this.meter.report(workspaceOf(auth), query.from, query.to);
    const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
    return {
      from: query.from,
      to: query.to,
      rows,
      totals: {
        calls: rows.reduce((n, r) => n + r.calls, 0),
        results: rows.reduce((n, r) => n + r.results, 0),
        costUsd: round6(rows.reduce((n, r) => n + r.costUsd, 0)),
      },
    };
  }
}
