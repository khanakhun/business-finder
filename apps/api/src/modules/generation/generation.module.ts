import type { AiGateway } from '@bf/ai';
import type { ApiEnv } from '@bf/config';
import type { DbClient } from '@bf/db';
import { HOTLINK_HOSTS } from '@bf/site-schema';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AI_BUDGET_GUARD, AI_GATEWAY } from '../platform/ai/ai.module.ts';
import { APP_ENV, type AppEnv, type AppMode } from '../platform/config/app-env.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';
import { InMemoryObjectStorage, type ObjectStorage } from '../platform/storage/object-storage.ts';
import { S3ObjectStorage } from '../platform/storage/s3-object-storage.ts';
import { VALKEY } from '../platform/valkey/valkey.module.ts';
import { RealtimeModule, RealtimePublisher } from '../realtime/index.ts';
import { SiteAssetCommands, SiteCommands, SiteQueries, SitesModule } from '../sites/index.ts';
import { BriefService, PAGE_PLAN_TEMPLATES } from './application/brief.service.ts';
import {
  BRIEF_SOURCES_READER,
  FACT_OVERLAY_REPOSITORY,
  FACT_SNAPSHOTS,
  FACT_SOURCES_READER,
  SITE_FACT_EXTRACTIONS,
  SITE_FACT_EXTRACTOR,
  SITE_FACT_TELEMETRY,
  SITE_PAGES_READER,
  type SitePagesReader,
} from './application/facts.ports.ts';
import { FactRegistryService } from './application/facts.service.ts';
import { GenerationCommands } from './application/generation.commands.ts';
import { GenerationNotifications } from './application/generation.notifications.ts';
import { GenerationQuality } from './application/generation.quality.ts';
import { GenerationQueries } from './application/generation.queries.ts';
import { GenerationRunner } from './application/generation.runner.ts';
import {
  type AgentEngine,
  type ArtifactStore,
  CANCEL_SIGNALS,
  ENGINE_REGISTRY,
  type EngineRegistry,
  EVENT_STREAM,
  GENERATION_ARTIFACTS,
  GENERATION_LIMITS,
  GENERATION_QUEUES,
  GENERATION_REPOSITORY,
  GENERATION_SETTINGS,
  GENERATION_TELEMETRY,
  type GenerationLimits,
  type GenerationRepository,
  LEASE_SEMAPHORE,
  LIVE_UPDATES,
  QUALITY_PIPELINE,
  SITE_HAND_OFF,
  WORKSPACE_BUDGET,
  WORKSPACE_PREPARER,
} from './application/ports.ts';
import { SiteFactExtraction } from './application/site-facts.extraction.ts';
import { JobTransitions, SETTLED_HOOK } from './application/transitions.ts';
import {
  BullmqGenerationQueues,
  GENERATION_REAPER_AUTOSTART,
  GenerationReaperScheduler,
  OPENAPI_GENERATION_QUEUES,
} from './infrastructure/bullmq-generation-queues.ts';
import {
  DefaultGenerationSettings,
  SchemaOnlyQualityPipeline,
  StaticEngineRegistry,
} from './infrastructure/defaults/defaults.ts';
import { FakeEngine } from './infrastructure/defaults/fake.engine.ts';
import { DrizzleBriefSources } from './infrastructure/drizzle-brief-sources.ts';
import {
  DrizzleFactOverlay,
  DrizzleFactSnapshots,
  DrizzleFactSources,
} from './infrastructure/drizzle-facts.repository.ts';
import { DrizzleGenerationRepository } from './infrastructure/drizzle-generation.repository.ts';
import { JobEventTail } from './infrastructure/job-event-tail.ts';
import { RealtimeLiveUpdates } from './infrastructure/live-updates.ts';
import { PROMETHEUS_TELEMETRY } from './infrastructure/metrics.ts';
import { pagePlans } from './infrastructure/page-plans.ts';
import {
  DrizzleSiteFactExtractions,
  DrizzleSitePages,
  GatewaySiteFactExtractor,
  PROMETHEUS_SITE_FACT_TELEMETRY,
} from './infrastructure/site-facts.adapters.ts';
import { SitesModuleHandOff } from './infrastructure/sites-hand-off.ts';
import {
  ValkeyCancelSignals,
  ValkeyEventStream,
  ValkeyLeaseSemaphore,
} from './infrastructure/valkey-adapters.ts';
import { LibrarySiteImages } from './infrastructure/workspace/library-images.ts';
import { BundleWorkspacePreparer } from './infrastructure/workspace/workspace-builder.ts';
import { FactsController } from './interface/http/facts.controller.ts';
import { GenerationController } from './interface/http/generation.controller.ts';
import {
  GenerationBlocksProcessor,
  GenerationClaudeAgentSdkProcessor,
  GenerationClaudeCodeProcessor,
  GenerationCodexProcessor,
  GenerationFakeProcessor,
  GenerationQualityProcessor,
  GenerationReaperProcessor,
} from './interface/processors/generation.processors.ts';

/** The engines registered here: the fake one in development and tests (real engines arrive with BF-041/BF-044). */
function engines(env: ApiEnv): AgentEngine[] {
  if (!env.GENERATION_FAKE_ENGINE) return [];
  if (env.NODE_ENV === 'production') throw new Error('GENERATION_FAKE_ENGINE is refused in production');
  return [
    new FakeEngine({ durationMs: env.GENERATION_FAKE_DURATION_MS, assetsBaseUrl: env.SITES_ASSETS_BASE_URL }),
  ];
}

/**
 * Site generation (BF-039, ADR-0010): batches and jobs on per-engine queues with priorities, four layers of
 * concurrency, failover, budgets, cancellation, an ordered event log, and the hand-off to the sites module.
 */
@Module({})
export class GenerationModule {
  static forRoot(mode: AppMode): DynamicModule {
    return {
      module: GenerationModule,
      imports: [SitesModule.forRoot(mode), RealtimeModule.forRoot(mode)],
      controllers: mode === 'worker' ? [] : [GenerationController, FactsController],
      providers: [
        { provide: GENERATION_REPOSITORY, useClass: DrizzleGenerationRepository },
        { provide: FACT_SOURCES_READER, useClass: DrizzleFactSources },
        { provide: FACT_OVERLAY_REPOSITORY, useClass: DrizzleFactOverlay },
        { provide: FACT_SNAPSHOTS, useClass: DrizzleFactSnapshots },
        FactRegistryService,
        {
          provide: SITE_PAGES_READER,
          inject: [DB_CLIENT, GENERATION_ARTIFACTS],
          useFactory: (db: DbClient, artifacts: ArtifactStore) => new DrizzleSitePages(db, artifacts),
        },
        {
          provide: SITE_FACT_EXTRACTOR,
          inject: [AI_GATEWAY],
          useFactory: (gateway: AiGateway) => new GatewaySiteFactExtractor(gateway),
        },
        {
          provide: SITE_FACT_EXTRACTIONS,
          inject: [DB_CLIENT],
          useFactory: (db: DbClient) => new DrizzleSiteFactExtractions(db),
        },
        { provide: SITE_FACT_TELEMETRY, useValue: PROMETHEUS_SITE_FACT_TELEMETRY },
        SiteFactExtraction,
        { provide: BRIEF_SOURCES_READER, useClass: DrizzleBriefSources },
        { provide: PAGE_PLAN_TEMPLATES, useFactory: () => pagePlans() },
        BriefService,
        {
          provide: ENGINE_REGISTRY,
          inject: [APP_ENV],
          useFactory: (env: AppEnv) => new StaticEngineRegistry(engines(env as ApiEnv)),
        },
        {
          provide: GENERATION_SETTINGS,
          inject: [ENGINE_REGISTRY],
          useFactory: (registry: EngineRegistry) =>
            new DefaultGenerationSettings(() => registry.list().map((engine) => engine.id)),
        },
        {
          provide: GENERATION_LIMITS,
          inject: [APP_ENV],
          useFactory: (env: AppEnv): GenerationLimits => ({
            maxSandboxes: (env as ApiEnv).GENERATION_MAX_SANDBOXES,
            heartbeatTimeoutMs: 120_000,
            heartbeatEveryMs: 15_000,
            attemptTimeoutMs: 45 * 60_000,
            slotRetryMs: 4_000,
            maxSpecBytes: 1_000_000,
          }),
        },
        {
          provide: GENERATION_ARTIFACTS,
          inject: [APP_ENV],
          useFactory: (env: AppEnv) => {
            const storage: ObjectStorage =
              mode === 'openapi'
                ? new InMemoryObjectStorage()
                : new S3ObjectStorage(env as ApiEnv, (env as ApiEnv).S3_BUCKET_ARTIFACTS);
            return {
              put: (key: string, body: Buffer, type: string) => storage.put(key, body, type),
              get: async (key: string) => (await storage.get(key))?.body,
            };
          },
        },
        {
          provide: WORKSPACE_PREPARER,
          inject: [
            SiteFactExtraction,
            FactRegistryService,
            BriefService,
            SITE_PAGES_READER,
            SiteAssetCommands,
            GENERATION_REPOSITORY,
            GENERATION_ARTIFACTS,
            APP_ENV,
          ],
          useFactory: (
            extraction: SiteFactExtraction,
            registry: FactRegistryService,
            briefs: BriefService,
            pages: SitePagesReader,
            library: SiteAssetCommands,
            repository: GenerationRepository,
            artifacts: ArtifactStore,
            env: AppEnv,
          ) =>
            new BundleWorkspacePreparer({
              extraction,
              registry,
              briefs,
              pages,
              images: new LibrarySiteImages(library),
              repository,
              artifacts,
              hosts: {
                assetHosts: [new URL((env as ApiEnv).SITES_ASSETS_BASE_URL).hostname],
                hotlinkHosts: HOTLINK_HOSTS,
              },
            }),
        },
        {
          provide: QUALITY_PIPELINE,
          inject: [APP_ENV],
          useFactory: (env: AppEnv) =>
            new SchemaOnlyQualityPipeline(
              [new URL((env as ApiEnv).SITES_ASSETS_BASE_URL).hostname],
              HOTLINK_HOSTS,
            ),
        },
        { provide: WORKSPACE_BUDGET, useExisting: AI_BUDGET_GUARD },
        {
          provide: SITE_HAND_OFF,
          inject: [SiteCommands, SiteQueries],
          useFactory: (commands: SiteCommands, queries: SiteQueries) =>
            new SitesModuleHandOff(commands, queries),
        },
        ...(mode === 'openapi'
          ? [
              { provide: GENERATION_QUEUES, useValue: OPENAPI_GENERATION_QUEUES },
              { provide: LEASE_SEMAPHORE, useValue: null },
              { provide: CANCEL_SIGNALS, useValue: null },
              { provide: EVENT_STREAM, useValue: null },
            ]
          : [
              { provide: GENERATION_QUEUES, useClass: BullmqGenerationQueues },
              {
                provide: LEASE_SEMAPHORE,
                inject: [VALKEY],
                useFactory: (valkey: Redis) => new ValkeyLeaseSemaphore(valkey),
              },
              {
                provide: CANCEL_SIGNALS,
                inject: [VALKEY],
                useFactory: (valkey: Redis) => new ValkeyCancelSignals(valkey),
              },
              {
                provide: EVENT_STREAM,
                inject: [VALKEY],
                useFactory: (valkey: Redis) => new ValkeyEventStream(valkey),
              },
            ]),
        { provide: GENERATION_TELEMETRY, useValue: PROMETHEUS_TELEMETRY },
        { provide: SETTLED_HOOK, useValue: PROMETHEUS_TELEMETRY.settled },
        {
          provide: LIVE_UPDATES,
          inject: [RealtimePublisher],
          useFactory: (realtime: RealtimePublisher) => new RealtimeLiveUpdates(realtime),
        },
        {
          provide: JobEventTail,
          inject: [VALKEY],
          useFactory: (valkey: Redis | null) => new JobEventTail(valkey as Redis),
        },
        GenerationNotifications,
        JobTransitions,
        GenerationCommands,
        GenerationQueries,
        GenerationRunner,
        GenerationQuality,
        ...(mode === 'worker'
          ? [
              GenerationBlocksProcessor,
              GenerationClaudeAgentSdkProcessor,
              GenerationClaudeCodeProcessor,
              GenerationCodexProcessor,
              GenerationFakeProcessor,
              GenerationQualityProcessor,
              GenerationReaperProcessor,
              GenerationReaperScheduler,
              { provide: GENERATION_REAPER_AUTOSTART, useValue: true },
            ]
          : []),
      ],
      exports: [GenerationCommands, GenerationQueries, FactRegistryService, SiteFactExtraction, BriefService],
    };
  }
}
