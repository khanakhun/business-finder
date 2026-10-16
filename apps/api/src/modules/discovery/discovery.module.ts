import type { ApiEnv } from '@bf/config';
import { type Clock, ExternalServiceError } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { type DynamicModule, Inject, Module, type OnModuleInit } from '@nestjs/common';
import { BusinessGraphModule } from '../business-graph/index.ts';
import { GeoModule } from '../geo/index.ts';
import { CLOCK } from '../platform/clock/clock.module.ts';
import { APP_ENV, type AppEnv, type AppMode } from '../platform/config/app-env.ts';
import { IntelClient } from '../platform/intel/intel-client.ts';
import { LOGGER } from '../platform/logging/logger.ts';
import { ValkeyRateLimiter } from '../platform/rate-limit/valkey-rate-limiter.ts';
import { RealtimeModule } from '../realtime/index.ts';
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
import {
  CancelDiscoveryRunCommand,
  DiscoveryRunPlanner,
  DiscoveryRunQueries,
  EstimateDiscoveryRunQuery,
  StartDiscoveryRunCommand,
} from './application/run.use-cases.ts';
import { DiscoveryRunNotifications } from './application/run-notifications.ts';
import { RunOrchestrator } from './application/run-orchestrator.ts';
import { DISCOVERY_RUN_REPOSITORY, RUN_PROGRESS, RUN_QUEUE, type RunQueue } from './application/run-ports.ts';
import { ScraperAcknowledgement } from './application/scraper-acknowledgement.ts';
import type { DiscoveryProvider } from './domain/provider.port.ts';
import { BullmqRunQueue } from './infrastructure/bullmq-run-queue.ts';
import { DrizzleCategoryProviderKeys } from './infrastructure/drizzle-category-provider-keys.ts';
import { DrizzleDiscoveryRunRepository } from './infrastructure/drizzle-discovery-run.repository.ts';
import { DrizzleProviderUsageMeter } from './infrastructure/drizzle-provider-usage-meter.ts';
import { GuardedProvider } from './infrastructure/guarded-provider.ts';
import { buildProviderPolicy } from './infrastructure/provider-resilience.ts';
import { FakeDiscoveryProvider } from './infrastructure/providers/fake/provider.ts';
import { GooglePlacesProvider } from './infrastructure/providers/google-places/provider.ts';
import { MapsScraperProvider } from './infrastructure/providers/maps-scraper/provider.ts';
import { OpenDataProvider } from './infrastructure/providers/open-data/provider.ts';
import { OsmOverpassProvider } from './infrastructure/providers/osm/provider.ts';
import { RealtimeRunProgress } from './infrastructure/realtime-run-progress.ts';
import { RECONCILER_AUTOSTART, RunReconciler } from './infrastructure/run-reconciler.ts';
import { DiscoveryController } from './interface/http/discovery.controller.ts';
import { DiscoveryRunsController } from './interface/http/discovery-runs.controller.ts';
import {
  DiscoveryFetchProcessor,
  DiscoveryIngestProcessor,
  DiscoveryPlanProcessor,
} from './interface/processors/discovery.processors.ts';

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
    if (fakeProviderEnabled(apiEnv)) {
      providers.push(guard(new FakeDiscoveryProvider(clock, apiEnv.FAKE_DISCOVERY_SYNTHETIC), null));
    }
    return new ProviderRegistry(providers);
  },
};

const noQueue = () => Promise.reject(new Error('no queue in openapi mode'));
const OPENAPI_RUN_QUEUE: RunQueue = {
  plan: noQueue,
  fetch: noQueue,
  ingest: noQueue,
  cancelFetches: noQueue,
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
      // Ingestion and tracking, areas and realtime come from their modules' public surfaces.
      imports: [BusinessGraphModule.forRoot(mode), GeoModule.forRoot(mode), RealtimeModule.forRoot(mode)],
      controllers: mode === 'worker' ? [] : [DiscoveryController, DiscoveryRunsController],
      providers: [
        { provide: DISCOVERY_RUN_REPOSITORY, useClass: DrizzleDiscoveryRunRepository },
        // OpenAPI generation connects to nothing: no queues in that mode.
        mode === 'openapi'
          ? { provide: RUN_QUEUE, useValue: OPENAPI_RUN_QUEUE }
          : { provide: RUN_QUEUE, useClass: BullmqRunQueue },
        { provide: RUN_PROGRESS, useClass: RealtimeRunProgress },
        // The worker runs the reconciler; the HTTP process only produces jobs.
        { provide: RECONCILER_AUTOSTART, useValue: mode === 'worker' },
        RunOrchestrator,
        RunReconciler,
        DiscoveryRunPlanner,
        EstimateDiscoveryRunQuery,
        StartDiscoveryRunCommand,
        CancelDiscoveryRunCommand,
        DiscoveryRunQueries,
        DiscoveryRunNotifications,
        ...(mode === 'worker'
          ? [DiscoveryPlanProcessor, DiscoveryFetchProcessor, DiscoveryIngestProcessor]
          : []),
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
      exports: [
        ProviderRegistry,
        ProviderQueryBuilder,
        ProviderCostEstimator,
        ProviderSelectionService,
        RunReconciler,
      ],
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
