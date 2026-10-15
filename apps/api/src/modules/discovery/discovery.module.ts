import type { ApiEnv } from '@bf/config';
import { type Clock, ExternalServiceError } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { type DynamicModule, Inject, Module, type OnModuleInit } from '@nestjs/common';
import { CLOCK } from '../platform/clock/clock.module.ts';
import { APP_ENV, type AppEnv, type AppMode } from '../platform/config/app-env.ts';
import { IntelClient } from '../platform/intel/intel-client.ts';
import { LOGGER } from '../platform/logging/logger.ts';
import { ConnectionTesterRegistry, SecretResolver, WorkspaceDefaults } from '../workspace/index.ts';
import {
  DiscoveryQueries,
  ProviderCostEstimator,
  ProviderQueryBuilder,
  ProviderSelectionService,
} from './application/discovery.services.ts';
import {
  CATEGORY_PROVIDER_KEYS,
  PROVIDER_USAGE_METER,
  type ProviderUsageMeter,
  RATE_LIMITER,
  type RateLimiter,
} from './application/ports.ts';
import { ProviderRegistry } from './application/provider-registry.ts';
import { ScraperAcknowledgement } from './application/scraper-acknowledgement.ts';
import type { DiscoveryProvider } from './domain/provider.port.ts';
import { DrizzleCategoryProviderKeys } from './infrastructure/drizzle-category-provider-keys.ts';
import { DrizzleProviderUsageMeter } from './infrastructure/drizzle-provider-usage-meter.ts';
import { GuardedProvider } from './infrastructure/guarded-provider.ts';
import { buildProviderPolicy } from './infrastructure/provider-resilience.ts';
import { FakeDiscoveryProvider } from './infrastructure/providers/fake/provider.ts';
import { GooglePlacesProvider } from './infrastructure/providers/google-places/provider.ts';
import { MapsScraperProvider } from './infrastructure/providers/maps-scraper/provider.ts';
import { OpenDataProvider } from './infrastructure/providers/open-data/provider.ts';
import { OsmOverpassProvider } from './infrastructure/providers/osm/provider.ts';
import { ValkeyRateLimiter } from './infrastructure/valkey-rate-limiter.ts';
import { DiscoveryController } from './interface/http/discovery.controller.ts';

/** The fixture provider exists only in tests and E2E (refused in production). */
function fakeProviderEnabled(env: ApiEnv): boolean {
  if (!env.FAKE_DISCOVERY_PROVIDER && env.NODE_ENV !== 'test') return false;
  if (env.NODE_ENV === 'production') throw new Error('FAKE_DISCOVERY_PROVIDER is refused in production');
  return true;
}

const registryProvider = {
  provide: ProviderRegistry,
  inject: [
    APP_ENV,
    CLOCK,
    SecretResolver,
    RATE_LIMITER,
    PROVIDER_USAGE_METER,
    WorkspaceDefaults,
    LOGGER,
    IntelClient,
    ScraperAcknowledgement,
  ],
  useFactory: (
    env: AppEnv,
    clock: Clock,
    secrets: SecretResolver,
    limiter: RateLimiter,
    meter: ProviderUsageMeter,
    defaults: WorkspaceDefaults,
    logger: Logger,
    intel: IntelClient,
    acknowledgement: ScraperAcknowledgement,
  ) => {
    const apiEnv = env as ApiEnv;
    const guard = (provider: DiscoveryProvider, perSecond: number | null) =>
      new GuardedProvider(provider, {
        secrets,
        limiter,
        meter,
        clock,
        logger,
        perSecond,
        policy: () => buildProviderPolicy(),
        monthlyBudgetUsd: async (organizationId) =>
          (await defaults.discoverySettings(organizationId)).monthlyBudgetUsd,
      });
    const providers = [
      guard(new GooglePlacesProvider(clock), apiEnv.GOOGLE_PLACES_REQUESTS_PER_SECOND),
      guard(
        new OpenDataProvider({
          dataset: 'overture',
          intel,
          clock,
          releaseFor: async (orgId) => (await defaults.discoverySettings(orgId)).overtureRelease,
        }),
        null,
      ),
      guard(new OpenDataProvider({ dataset: 'foursquare', intel, clock }), null),
      guard(
        new OsmOverpassProvider({
          clock,
          endpoint: apiEnv.OVERPASS_URL,
          contactEmail: apiEnv.OVERPASS_CONTACT_EMAIL,
        }),
        apiEnv.OVERPASS_REQUESTS_PER_SECOND,
      ),
    ];
    // Legally sensitive: registered only when the deployment enables it (the workspace flag and an owner
    // acknowledgement are checked per call).
    if (apiEnv.FEATURE_MAPS_SCRAPER && apiEnv.MAPS_SCRAPER_URL) {
      providers.push(
        guard(
          new MapsScraperProvider({
            clock,
            baseUrl: apiEnv.MAPS_SCRAPER_URL,
            maxTimeSeconds: apiEnv.MAPS_SCRAPER_MAX_TIME_SECONDS,
            acknowledged: (orgId) => acknowledgement.allowed(orgId),
          }),
          1,
        ),
      );
    }
    if (fakeProviderEnabled(apiEnv)) providers.push(guard(new FakeDiscoveryProvider(clock), null));
    return new ProviderRegistry(providers);
  },
};

/** Messages users see for a failed key test (never the provider's raw error, which may quote the request). */
function connectionFailure(error: unknown): { ok: false; message: string } {
  const reason = error instanceof ExternalServiceError ? error.details?.reason : undefined;
  return {
    ok: false,
    message:
      reason === 'PERMISSION_DENIED'
        ? 'The key was rejected: check it, and that Places API (New) and billing are enabled for its project.'
        : reason === 'INVALID_ARGUMENT'
          ? 'The provider rejected the test request.'
          : 'The connection test failed.',
  };
}

/** Discovery (BF-018): provider framework, Google Places, usage metering. Runs come with BF-020. */
@Module({})
export class DiscoveryModule implements OnModuleInit {
  constructor(
    @Inject(ProviderRegistry) private readonly registry: ProviderRegistry,
    @Inject(ConnectionTesterRegistry) private readonly testers: ConnectionTesterRegistry,
  ) {}

  static forRoot(mode: AppMode): DynamicModule {
    return {
      module: DiscoveryModule,
      controllers: mode === 'worker' ? [] : [DiscoveryController],
      providers: [
        { provide: CATEGORY_PROVIDER_KEYS, useClass: DrizzleCategoryProviderKeys },
        { provide: PROVIDER_USAGE_METER, useClass: DrizzleProviderUsageMeter },
        { provide: RATE_LIMITER, useClass: ValkeyRateLimiter },
        IntelClient,
        ScraperAcknowledgement,
        registryProvider,
        ProviderQueryBuilder,
        ProviderCostEstimator,
        ProviderSelectionService,
        DiscoveryQueries,
      ],
      exports: [ProviderRegistry, ProviderQueryBuilder, ProviderCostEstimator, ProviderSelectionService],
    };
  }

  /** Settings → Integrations can test provider keys (fake testers, when enabled, take precedence). */
  onModuleInit(): void {
    for (const provider of this.registry.all()) {
      const name = provider.secretName;
      if (!name || this.testers.has(name)) continue;
      this.testers.register(name, async ({ value, signal }) => {
        try {
          return await provider.testConnection({ value, source: 'workspace' }, signal);
        } catch (error) {
          return connectionFailure(error);
        }
      });
    }
  }
}
