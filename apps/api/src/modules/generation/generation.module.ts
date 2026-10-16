import type { ApiEnv } from '@bf/config';
import { HOTLINK_HOSTS } from '@bf/site-schema';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AI_BUDGET_GUARD } from '../platform/ai/ai.module.ts';
import { APP_ENV, type AppEnv, type AppMode } from '../platform/config/app-env.ts';
import { InMemoryObjectStorage, type ObjectStorage } from '../platform/storage/object-storage.ts';
import { S3ObjectStorage } from '../platform/storage/s3-object-storage.ts';
import { VALKEY } from '../platform/valkey/valkey.module.ts';
import { SiteCommands, SiteQueries, SitesModule } from '../sites/index.ts';
import { GenerationCommands } from './application/generation.commands.ts';
import { GenerationQuality } from './application/generation.quality.ts';
import { GenerationQueries } from './application/generation.queries.ts';
import { GenerationRunner } from './application/generation.runner.ts';
import {
  type AgentEngine,
  CANCEL_SIGNALS,
  ENGINE_REGISTRY,
  type EngineRegistry,
  EVENT_STREAM,
  GENERATION_ARTIFACTS,
  GENERATION_LIMITS,
  GENERATION_QUEUES,
  GENERATION_REPOSITORY,
  GENERATION_SETTINGS,
  type GenerationLimits,
  LEASE_SEMAPHORE,
  QUALITY_PIPELINE,
  SITE_HAND_OFF,
  WORKSPACE_BUDGET,
  WORKSPACE_PREPARER,
} from './application/ports.ts';
import { JobTransitions } from './application/transitions.ts';
import {
  BullmqGenerationQueues,
  GENERATION_REAPER_AUTOSTART,
  GenerationReaperScheduler,
  OPENAPI_GENERATION_QUEUES,
} from './infrastructure/bullmq-generation-queues.ts';
import {
  DefaultGenerationSettings,
  FixtureWorkspacePreparer,
  SchemaOnlyQualityPipeline,
  StaticEngineRegistry,
} from './infrastructure/defaults/defaults.ts';
import { FakeEngine } from './infrastructure/defaults/fake.engine.ts';
import { DrizzleGenerationRepository } from './infrastructure/drizzle-generation.repository.ts';
import { SitesModuleHandOff } from './infrastructure/sites-hand-off.ts';
import {
  ValkeyCancelSignals,
  ValkeyEventStream,
  ValkeyLeaseSemaphore,
} from './infrastructure/valkey-adapters.ts';
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
      imports: [SitesModule.forRoot(mode)],
      controllers: mode === 'worker' ? [] : [GenerationController],
      providers: [
        { provide: GENERATION_REPOSITORY, useClass: DrizzleGenerationRepository },
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
          inject: [GENERATION_ARTIFACTS],
          useFactory: (artifacts: { put: (key: string, body: Buffer, type: string) => Promise<void> }) =>
            new FixtureWorkspacePreparer((key, body) => artifacts.put(key, body, 'application/json')),
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
      exports: [GenerationCommands, GenerationQueries],
    };
  }
}
