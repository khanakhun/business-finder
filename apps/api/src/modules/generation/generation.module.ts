import type { AiGateway } from '@bf/ai';
import type { ApiEnv } from '@bf/config';
import type { DbClient } from '@bf/db';
import { HOTLINK_HOSTS } from '@bf/site-schema';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AI_BUDGET_GUARD, AI_GATEWAY } from '../platform/ai/ai.module.ts';
import { vaultKeyResolver } from '../platform/ai/ai-adapters.ts';
import { APP_ENV, type AppEnv, type AppMode } from '../platform/config/app-env.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';
import { InMemoryObjectStorage, type ObjectStorage } from '../platform/storage/object-storage.ts';
import { S3ObjectStorage } from '../platform/storage/s3-object-storage.ts';
import { VALKEY } from '../platform/valkey/valkey.module.ts';
import { RealtimeModule, RealtimePublisher } from '../realtime/index.ts';
import { SiteAssetCommands, SiteCommands, SiteQueries, SitesModule } from '../sites/index.ts';
import { SecretResolver } from '../workspace/index.ts';
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
import { GenerationFiles } from './application/generation.files.ts';
import { GenerationNotifications } from './application/generation.notifications.ts';
import { GenerationQuality } from './application/generation.quality.ts';
import { GenerationQueries } from './application/generation.queries.ts';
import { GenerationReview } from './application/generation.review.ts';
import { GenerationRunner } from './application/generation.runner.ts';
import {
  GENERATION_SETTINGS_DEFAULTS,
  GenerationSettingsService,
} from './application/generation.settings.ts';
import {
  type AgentEngine,
  type ArtifactStore,
  BUNDLE_UNPACKER,
  CANCEL_SIGNALS,
  ENGINE_REGISTRY,
  type EngineRegistry,
  EVENT_STREAM,
  GENERATION_ARTIFACTS,
  GENERATION_LIMITS,
  GENERATION_QUEUES,
  GENERATION_REPOSITORY,
  GENERATION_SETTINGS,
  GENERATION_SETTINGS_STORE,
  GENERATION_TELEMETRY,
  type GenerationLimits,
  type GenerationRepository,
  LEASE_SEMAPHORE,
  LIVE_UPDATES,
  QUALITY_PIPELINE,
  QUALITY_TELEMETRY,
  SITE_HAND_OFF,
  WORKSPACE_BUDGET,
  WORKSPACE_PREPARER,
} from './application/ports.ts';
import { SANDBOX_JANITOR, SANDBOX_PROVIDER, type SandboxProvider } from './application/sandbox.ports.ts';
import { SiteFactExtraction } from './application/site-facts.extraction.ts';
import { JobTransitions, SETTLED_HOOK } from './application/transitions.ts';
import {
  BullmqGenerationQueues,
  GENERATION_REAPER_AUTOSTART,
  GenerationReaperScheduler,
  OPENAPI_GENERATION_QUEUES,
} from './infrastructure/bullmq-generation-queues.ts';
import { DefaultGenerationSettings, StaticEngineRegistry } from './infrastructure/defaults/defaults.ts';
import { FakeEngine } from './infrastructure/defaults/fake.engine.ts';
import { DrizzleBriefSources } from './infrastructure/drizzle-brief-sources.ts';
import {
  DrizzleFactOverlay,
  DrizzleFactSnapshots,
  DrizzleFactSources,
} from './infrastructure/drizzle-facts.repository.ts';
import { DrizzleGenerationRepository } from './infrastructure/drizzle-generation.repository.ts';
import { DrizzleGenerationSettingsStore } from './infrastructure/drizzle-generation-settings.ts';
import { BlocksEngine } from './infrastructure/engines/blocks/blocks.engine.ts';
import { ClaudeAgentSdkEngine } from './infrastructure/engines/claude-agent-sdk/claude-agent-sdk.engine.ts';
import { ClaudeCodeEngine } from './infrastructure/engines/claude-code/claude-code.engine.ts';
import { CodexEngine } from './infrastructure/engines/codex/codex.engine.ts';
import type { SandboxedEngineDeps } from './infrastructure/engines/sandboxed/sandboxed-agent.engine.ts';
import { JobEventTail } from './infrastructure/job-event-tail.ts';
import { RealtimeLiveUpdates } from './infrastructure/live-updates.ts';
import {
  PROMETHEUS_QUALITY_TELEMETRY,
  PROMETHEUS_SANDBOX_TELEMETRY,
  PROMETHEUS_TELEMETRY,
} from './infrastructure/metrics.ts';
import { pagePlans } from './infrastructure/page-plans.ts';
import { FullQualityPipeline } from './infrastructure/quality/full-quality.pipeline.ts';
import { type AuditAssets, SandboxAuditClient } from './infrastructure/quality/sandbox-audit.client.ts';
import { HttpDockerApi } from './infrastructure/sandbox/docker-engine.ts';
import { DockerSandboxProvider } from './infrastructure/sandbox/docker-sandbox.ts';
import { SandboxJanitor } from './infrastructure/sandbox/janitor.ts';
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
import { unpackBundle } from './infrastructure/workspace/tar.ts';
import { BundleWorkspacePreparer } from './infrastructure/workspace/workspace-builder.ts';
import { FactsController } from './interface/http/facts.controller.ts';
import { GenerationController } from './interface/http/generation.controller.ts';
import { JobFilesController } from './interface/http/job-files.controller.ts';
import { QualityController } from './interface/http/quality.controller.ts';
import { GenerationSettingsController } from './interface/http/settings.controller.ts';
import {
  GenerationBlocksProcessor,
  GenerationClaudeAgentSdkProcessor,
  GenerationClaudeCodeProcessor,
  GenerationCodexProcessor,
  GenerationFakeProcessor,
  GenerationQualityProcessor,
  GenerationReaperProcessor,
} from './interface/processors/generation.processors.ts';

/**
 * The site's public assets for the no-network audit (BF-045): our CDN's files, read from the sites bucket behind it
 * (the key is the URL's path under SITES_ASSETS_BASE_URL), never fetched over the network.
 */
function siteAssets(env: ApiEnv): AuditAssets {
  const base = env.SITES_ASSETS_BASE_URL.replace(/\/+$/, '');
  const storage = new S3ObjectStorage(env, env.S3_BUCKET_SITES);
  return {
    hosts: [new URL(base).hostname],
    async fetch(url) {
      if (!url.startsWith(`${base}/`)) return undefined;
      const key = decodeURIComponent(url.slice(base.length + 1).split(/[?#]/)[0] ?? '');
      return (await storage.get(key))?.body;
    },
  };
}

/** The engines registered here: blocks (BF-041), the coding agents in sandboxes (BF-044), the fake one in tests. */
function engines(
  env: ApiEnv,
  deps: { gateway: AiGateway; artifacts: ArtifactStore; sandbox: SandboxProvider; secrets: SecretResolver },
): AgentEngine[] {
  const registered: AgentEngine[] = [];
  // The blocks engine (BF-041): in-process, model calls through the AI gateway.
  if (env.GENERATION_BLOCKS_ENGINE) registered.push(new BlocksEngine(deps.gateway, deps.artifacts));
  // The coding agents (BF-044): each run in a sandbox with the workspace's own key.
  const keys = vaultKeyResolver(deps.secrets);
  const sandboxed = (provider: 'anthropic' | 'openai', model: string): SandboxedEngineDeps => ({
    sandbox: deps.sandbox,
    artifacts: deps.artifacts,
    keys: { resolve: (organizationId) => keys.resolve(organizationId, provider) },
    settings: {
      enabled: env.SANDBOX_ENABLED,
      image: env.SANDBOX_RUNNER_IMAGE,
      cpus: env.SANDBOX_CPUS,
      memoryMb: env.SANDBOX_MEMORY_MB,
      pidsLimit: env.SANDBOX_PIDS_LIMIT,
      wallTimeSec: env.GENERATION_AGENT_WALL_TIME_SEC,
      maxTurns: env.GENERATION_AGENT_MAX_TURNS,
      budgetMargin: env.GENERATION_AGENT_BUDGET_MARGIN,
      model,
    },
  });
  if (env.GENERATION_CLAUDE_CODE_ENGINE)
    registered.push(
      new ClaudeCodeEngine(sandboxed('anthropic', env.AI_MODEL_AGENT), {
        pricing: env.AI_PRICING,
        sitekit: env.GENERATION_CLAUDE_CODE_SITEKIT,
      }),
    );
  if (env.GENERATION_CLAUDE_AGENT_SDK_ENGINE)
    registered.push(
      new ClaudeAgentSdkEngine(sandboxed('anthropic', env.AI_MODEL_AGENT), { pricing: env.AI_PRICING }),
    );
  if (env.GENERATION_CODEX_ENGINE)
    registered.push(
      new CodexEngine(sandboxed('openai', env.GENERATION_CODEX_MODEL), {
        pricing: env.AI_PRICING,
        reasoningEffort: env.GENERATION_CODEX_REASONING_EFFORT,
      }),
    );
  if (env.GENERATION_FAKE_ENGINE) {
    if (env.NODE_ENV === 'production') throw new Error('GENERATION_FAKE_ENGINE is refused in production');
    registered.push(
      new FakeEngine({
        durationMs: env.GENERATION_FAKE_DURATION_MS,
        assetsBaseUrl: env.SITES_ASSETS_BASE_URL,
        artifacts: deps.artifacts,
      }),
    );
  }
  return registered;
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
      controllers:
        mode === 'worker'
          ? []
          : [
              GenerationController,
              FactsController,
              QualityController,
              JobFilesController,
              GenerationSettingsController,
            ],
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
        { provide: BUNDLE_UNPACKER, useValue: unpackBundle },
        SiteFactExtraction,
        { provide: BRIEF_SOURCES_READER, useClass: DrizzleBriefSources },
        { provide: PAGE_PLAN_TEMPLATES, useFactory: () => pagePlans() },
        BriefService,
        {
          provide: ENGINE_REGISTRY,
          inject: [APP_ENV, AI_GATEWAY, GENERATION_ARTIFACTS, SANDBOX_PROVIDER, SecretResolver],
          useFactory: (
            env: AppEnv,
            gateway: AiGateway,
            artifacts: ArtifactStore,
            sandbox: SandboxProvider,
            secrets: SecretResolver,
          ) => new StaticEngineRegistry(engines(env as ApiEnv, { gateway, artifacts, sandbox, secrets })),
        },
        {
          provide: GENERATION_SETTINGS_DEFAULTS,
          inject: [ENGINE_REGISTRY],
          useFactory: (registry: EngineRegistry) =>
            new DefaultGenerationSettings(() => registry.list().map((engine) => engine.id)),
        },
        // A workspace's stored settings over those defaults (BF-046).
        { provide: GENERATION_SETTINGS_STORE, useClass: DrizzleGenerationSettingsStore },
        GenerationSettingsService,
        { provide: GENERATION_SETTINGS, useExisting: GenerationSettingsService },
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
          inject: [APP_ENV, GENERATION_ARTIFACTS, GENERATION_REPOSITORY, SANDBOX_PROVIDER, AI_GATEWAY],
          useFactory: (
            appEnv: AppEnv,
            artifacts: ArtifactStore,
            repository: GenerationRepository,
            sandbox: SandboxProvider,
            gateway: AiGateway,
          ) => {
            const env = appEnv as ApiEnv;
            if (env.GENERATION_QUALITY_AUDITS && !env.SANDBOX_ENABLED)
              throw new Error(
                'GENERATION_QUALITY_AUDITS needs SANDBOX_ENABLED (the audits run in a sandbox)',
              );
            return new FullQualityPipeline({
              artifacts,
              repository,
              assetHosts: [new URL(env.SITES_ASSETS_BASE_URL).hostname],
              hotlinkHosts: HOTLINK_HOSTS,
              ...(env.GENERATION_QUALITY_AI_GATES ? { gateway } : {}),
              ...(env.GENERATION_QUALITY_AUDITS
                ? {
                    audits: new SandboxAuditClient(
                      sandbox,
                      {
                        image: env.SANDBOX_RUNNER_IMAGE,
                        cpus: env.SANDBOX_CPUS,
                        memoryMb: env.SANDBOX_MEMORY_MB,
                        pidsLimit: env.SANDBOX_PIDS_LIMIT,
                        wallTimeSec: env.GENERATION_QUALITY_AUDIT_WALL_TIME_SEC,
                      },
                      siteAssets(env),
                    ),
                  }
                : {}),
            });
          },
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
        { provide: QUALITY_TELEMETRY, useValue: PROMETHEUS_QUALITY_TELEMETRY },
        {
          provide: SANDBOX_JANITOR,
          inject: [APP_ENV],
          useFactory: (env: AppEnv) =>
            (env as ApiEnv).SANDBOX_ENABLED
              ? new SandboxJanitor(new HttpDockerApi((env as ApiEnv).SANDBOX_DOCKER_HOST))
              : null,
        },
        // Sandboxes (BF-043) for the CLI engines (BF-044): the Docker Engine API through the socket proxy.
        {
          provide: SANDBOX_PROVIDER,
          inject: [APP_ENV],
          useFactory: (env: AppEnv) => {
            const api = env as ApiEnv;
            return new DockerSandboxProvider(
              new HttpDockerApi(api.SANDBOX_DOCKER_HOST),
              {
                network: api.SANDBOX_NETWORK,
                ...(api.SANDBOX_EGRESS_PROXY_URL ? { egressProxyUrl: api.SANDBOX_EGRESS_PROXY_URL } : {}),
              },
              PROMETHEUS_SANDBOX_TELEMETRY,
            );
          },
        },
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
        GenerationReview,
        GenerationQueries,
        GenerationFiles,
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
