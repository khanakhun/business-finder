import { type AiGateway, type BudgetGuard, type LlmCallRecorder, loadPromptRegistry } from '@bf/ai';
import type { ApiEnv } from '@bf/config';
import type { DbClient } from '@bf/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AI_BUDGET_GUARD, AI_GATEWAY } from '../platform/ai/ai.module.ts';
import { LlmCallRepository } from '../platform/ai/llm-call.repository.ts';
import { APP_ENV, type AppEnv, type AppMode } from '../platform/config/app-env.ts';
import { DB_CLIENT } from '../platform/db/db.module.ts';
import { IntelClient } from '../platform/intel/intel-client.ts';
import { InMemoryObjectStorage, type ObjectStorage } from '../platform/storage/object-storage.ts';
import { S3ObjectStorage } from '../platform/storage/s3-object-storage.ts';
import { VALKEY } from '../platform/valkey/valkey.module.ts';
import { SecretResolver } from '../workspace/index.ts';
import {
  AssetSourcing,
  IMAGE_ANALYZER,
  IMAGE_FETCHER,
  OWNER_SITE_IMAGES,
  WORDMARK_MAKER,
} from './application/asset-sourcing.ts';
import { DOMAIN_SWEEP_AUTOSTART, DomainsService } from './application/go-live/domains.service.ts';
import { GoLiveService } from './application/go-live/go-live.service.ts';
import { DNS_RESOLVER, DOMAIN_REPOSITORY, GO_LIVE_REPOSITORY } from './application/go-live/ports.ts';
import {
  ASSET_PROCESSING_QUEUE,
  ASSET_SOURCING_QUEUE,
  IMAGE_PROCESSOR,
  type ImageProcessor,
  PUBLIC_FILES,
  SITE_ARTIFACTS,
  SITE_ASSETS_REPOSITORY,
  SITE_HOSTING,
  SITE_INSIGHTS,
  SITE_ORIGINALS,
  SITE_REVALIDATION,
  SITE_SCREENSHOT_QUEUE,
  SITE_SCREENSHOTTER,
  SITE_THUMBNAILS_REPOSITORY,
  SITE_VIEW_COUNTER,
  SITE_VIEW_SECRET,
  SITE_VIEWS_REPOSITORY,
  SITES_REPOSITORY,
  type SiteHosting,
  UPLOAD_SIGNER,
} from './application/ports.ts';
import { SiteAssetCommands } from './application/site-assets.ts';
import { SiteInsightsReader, SiteThumbnailCommands } from './application/site-thumbnails.ts';
import { SiteViewAttribution } from './application/site-view-attribution.ts';
import { SiteViewRecorder, SiteViewsFlusher } from './application/site-views.ts';
import { SiteCommands } from './application/sites.commands.ts';
import { SiteQueries } from './application/sites.queries.ts';
import { SiteRenderSubscriber } from './application/sites.subscribers.ts';
import {
  AI_IMAGE_ALLOWANCE,
  AI_IMAGE_SETTINGS,
  GENERATION_QUEUE,
  IMAGE_GENERATOR,
  STOCK_PROVIDERS,
  StockAndAiImages,
} from './application/stock-and-ai.ts';
import { HOTLINK_HOSTS } from './domain/assets/licensing-profile.ts';
import { sitesShareCookieDomain } from './domain/hosting.ts';
import {
  FakeImageGenerator,
  LedgerAiImageAllowance,
  OpenAiImageGenerator,
} from './infrastructure/assets/ai-image.adapters.ts';
import {
  AiImageAnalyzer,
  DrizzleOwnerSiteImages,
  FakeImageAnalyzer,
  FakeImageFetcher,
  IntelImageFetcher,
  OpentypeWordmarkMaker,
} from './infrastructure/assets/sourcing.adapters.ts';
import {
  FakeStockProvider,
  GuardedStockProvider,
  PexelsProvider,
  UnsplashProvider,
} from './infrastructure/assets/stock.adapters.ts';
import {
  BullmqAssetProcessingQueue,
  BullmqAssetSourcingQueue,
  BullmqGenerationQueue,
  BullmqSiteRevalidation,
  BullmqSiteScreenshotQueue,
  OPENAPI_ASSET_QUEUE,
  OPENAPI_GENERATION_QUEUE,
  OPENAPI_SCREENSHOT_QUEUE,
  OPENAPI_SITE_REVALIDATION,
  OPENAPI_SOURCING_QUEUE,
  SCREENSHOT_DELAY_MS,
  SITES_EXPIRY_AUTOSTART,
  SITES_VIEWS_AUTOSTART,
  SitesExpiryScheduler,
  SitesViewsFlushScheduler,
} from './infrastructure/bullmq-site-jobs.ts';
import { DrizzleDomainRepository } from './infrastructure/drizzle-domain.repository.ts';
import { DrizzleGoLiveRepository } from './infrastructure/drizzle-go-live.repository.ts';
import { DrizzleSiteAssetsRepository } from './infrastructure/drizzle-site-assets.repository.ts';
import { DrizzleSiteThumbnailsRepository } from './infrastructure/drizzle-site-thumbnails.repository.ts';
import { DrizzleSiteViewsRepository } from './infrastructure/drizzle-site-views.repository.ts';
import { DrizzleSitesRepository } from './infrastructure/drizzle-sites.repository.ts';
import { FakeSiteScreenshotter, IntelSiteScreenshotter } from './infrastructure/intel-site-screenshotter.ts';
import { NodeDnsResolver } from './infrastructure/node-dns-resolver.ts';
import { RendererRevalidator } from './infrastructure/renderer-revalidator.ts';
import { SharpImageProcessor } from './infrastructure/sharp-image-processor.ts';
import {
  FakeUploadSigner,
  InMemoryPublicFiles,
  S3PublicFiles,
  S3UploadSigner,
} from './infrastructure/site-asset-storage.ts';
import { ValkeySiteViewCounter } from './infrastructure/valkey-site-views.ts';
import { InternalDomainsController, SiteDomainsController } from './interface/http/domains.controller.ts';
import { GoLiveController, PublicContactRoutingController } from './interface/http/go-live.controller.ts';
import { PublicSiteViewsController } from './interface/http/public-site-views.controller.ts';
import { SiteAssetsController } from './interface/http/site-assets.controller.ts';
import { SitesController } from './interface/http/sites.controller.ts';
import {
  SitesAssetAnalyzeProcessor,
  SitesAssetCollectProcessor,
  SitesAssetGenerateProcessor,
  SitesAssetProcessProcessor,
  SitesExpireProcessor,
  SitesRevalidateProcessor,
  SitesScreenshotProcessor,
  SitesViewsFlushProcessor,
} from './interface/processors/sites.processors.ts';

/** The view secret: optional locally (no views are counted), required in production. */
function viewSecret(env: ApiEnv): string | undefined {
  if (!env.SITES_VIEW_TOKEN_SECRET && env.NODE_ENV === 'production')
    throw new Error('SITES_VIEW_TOKEN_SECRET is required in production (site views would not be counted).');
  return env.SITES_VIEW_TOKEN_SECRET;
}

/** The fake screenshots exist only in tests and E2E (refused in production). */
function fakeScreenshots(env: ApiEnv): boolean {
  if (!env.FAKE_SITE_INTEL) return false;
  if (env.NODE_ENV === 'production') throw new Error('FAKE_SITE_INTEL is refused in production');
  return true;
}

/**
 * Sites (BF-035): sites, immutable versions and publications, the renderer's revalidation and the preview expiry;
 * images (presigned uploads, processed variants), pictures of published sites and anonymous view counts.
 * The renderer (BF-036) reads published versions from the `renderer_published_sites` view, not through this module.
 */
@Module({})
export class SitesModule {
  private static readonly byMode = new Map<AppMode, DynamicModule>();

  static forRoot(mode: AppMode): DynamicModule {
    let definition = SitesModule.byMode.get(mode);
    if (!definition) {
      definition = SitesModule.build(mode);
      SitesModule.byMode.set(mode, definition);
    }
    return definition;
  }

  private static build(mode: AppMode): DynamicModule {
    return {
      module: SitesModule,
      controllers:
        mode === 'worker'
          ? []
          : [
              SitesController,
              SiteAssetsController,
              PublicSiteViewsController,
              // BF-062: going live.
              GoLiveController,
              PublicContactRoutingController,
              SiteDomainsController,
              InternalDomainsController,
            ],
      providers: [
        { provide: SITES_REPOSITORY, useClass: DrizzleSitesRepository },
        { provide: SITE_ASSETS_REPOSITORY, useClass: DrizzleSiteAssetsRepository },
        { provide: SITE_THUMBNAILS_REPOSITORY, useClass: DrizzleSiteThumbnailsRepository },
        { provide: SITE_VIEWS_REPOSITORY, useClass: DrizzleSiteViewsRepository },
        { provide: SITE_VIEW_COUNTER, useClass: ValkeySiteViewCounter },
        {
          provide: SITE_VIEW_SECRET,
          inject: [APP_ENV],
          useFactory: (env: AppEnv) => viewSecret(env as ApiEnv),
        },
        { provide: IMAGE_PROCESSOR, useClass: SharpImageProcessor },
        // OpenAPI generation connects to nothing: no queues or buckets in that mode.
        ...(mode === 'openapi'
          ? [
              { provide: SITE_REVALIDATION, useValue: OPENAPI_SITE_REVALIDATION },
              { provide: ASSET_PROCESSING_QUEUE, useValue: OPENAPI_ASSET_QUEUE },
              { provide: ASSET_SOURCING_QUEUE, useValue: OPENAPI_SOURCING_QUEUE },
              { provide: GENERATION_QUEUE, useValue: OPENAPI_GENERATION_QUEUE },
              { provide: SITE_SCREENSHOT_QUEUE, useValue: OPENAPI_SCREENSHOT_QUEUE },
              { provide: SITE_ORIGINALS, useValue: new InMemoryObjectStorage() },
              { provide: SITE_ARTIFACTS, useValue: new InMemoryObjectStorage() },
              { provide: PUBLIC_FILES, useValue: new InMemoryPublicFiles() },
              { provide: UPLOAD_SIGNER, useValue: new FakeUploadSigner() },
            ]
          : [
              { provide: SITE_REVALIDATION, useClass: BullmqSiteRevalidation },
              { provide: ASSET_PROCESSING_QUEUE, useClass: BullmqAssetProcessingQueue },
              { provide: ASSET_SOURCING_QUEUE, useClass: BullmqAssetSourcingQueue },
              { provide: GENERATION_QUEUE, useClass: BullmqGenerationQueue },
              { provide: SITE_SCREENSHOT_QUEUE, useClass: BullmqSiteScreenshotQueue },
              { provide: SCREENSHOT_DELAY_MS, useValue: 15_000 },
              {
                provide: SITE_ORIGINALS,
                inject: [APP_ENV],
                useFactory: (env: AppEnv) => new S3ObjectStorage(env as ApiEnv),
              },
              {
                provide: SITE_ARTIFACTS,
                inject: [APP_ENV],
                useFactory: (env: AppEnv) =>
                  new S3ObjectStorage(env as ApiEnv, (env as ApiEnv).S3_BUCKET_ARTIFACTS),
              },
              {
                provide: PUBLIC_FILES,
                inject: [APP_ENV],
                useFactory: (env: AppEnv) => new S3PublicFiles(env as ApiEnv),
              },
              {
                provide: UPLOAD_SIGNER,
                inject: [APP_ENV],
                useFactory: (env: AppEnv) => new S3UploadSigner(env as ApiEnv),
              },
            ]),
        {
          provide: SITE_HOSTING,
          inject: [APP_ENV],
          useFactory: (env: AppEnv): SiteHosting => {
            const api = env as ApiEnv;
            // Previews must not share the dashboard's cookies: under the auth cookie domain, every preview host
            // would receive staff sessions and count as same-site with the API.
            if (
              api.NODE_ENV === 'production' &&
              sitesShareCookieDomain(api.SITES_BASE_DOMAIN, api.AUTH_COOKIE_DOMAIN)
            )
              throw new Error(
                'SITES_BASE_DOMAIN must not be under AUTH_COOKIE_DOMAIN (use a separate domain).',
              );
            return {
              baseDomain: api.SITES_BASE_DOMAIN,
              assetHosts: [new URL(api.SITES_ASSETS_BASE_URL).hostname],
              hotlinkHosts: HOTLINK_HOSTS,
            };
          },
        },
        {
          provide: SITE_SCREENSHOTTER,
          inject: [APP_ENV, IntelClient, SITE_ARTIFACTS],
          useFactory: (env: AppEnv, intel: IntelClient, artifacts: ObjectStorage) =>
            fakeScreenshots(env as ApiEnv)
              ? new FakeSiteScreenshotter(artifacts)
              : new IntelSiteScreenshotter(intel),
        },
        IntelClient,
        // Image sourcing (BF-038): fakes (no network, no model) only where the site intel is faked (tests, E2E).
        {
          provide: OWNER_SITE_IMAGES,
          inject: [DB_CLIENT],
          useFactory: (db: DbClient) => new DrizzleOwnerSiteImages(db),
        },
        {
          provide: IMAGE_FETCHER,
          inject: [APP_ENV, IntelClient],
          useFactory: (env: AppEnv, intel: IntelClient) =>
            fakeScreenshots(env as ApiEnv) ? new FakeImageFetcher() : new IntelImageFetcher(intel),
        },
        {
          provide: WORDMARK_MAKER,
          inject: [IMAGE_PROCESSOR],
          useFactory: (images: ImageProcessor) => new OpentypeWordmarkMaker(images),
        },
        {
          provide: IMAGE_ANALYZER,
          inject: [APP_ENV, AI_GATEWAY],
          useFactory: (env: AppEnv, gateway: AiGateway) =>
            fakeScreenshots(env as ApiEnv) ? new FakeImageAnalyzer() : new AiImageAnalyzer(gateway),
        },
        AssetSourcing,
        // Stock photos and AI images (BF-038 part 2): fakes (no network, no cost) where the site intel is faked.
        {
          provide: STOCK_PROVIDERS,
          inject: [APP_ENV, SecretResolver, VALKEY],
          useFactory: (env: AppEnv, secrets: SecretResolver, valkey: Redis) =>
            fakeScreenshots(env as ApiEnv)
              ? [new FakeStockProvider()]
              : [new UnsplashProvider(secrets), new PexelsProvider(secrets)].map(
                  (provider) => new GuardedStockProvider(provider, valkey),
                ),
        },
        {
          provide: IMAGE_GENERATOR,
          inject: [APP_ENV, SecretResolver],
          useFactory: (env: AppEnv, secrets: SecretResolver) =>
            fakeScreenshots(env as ApiEnv)
              ? new FakeImageGenerator()
              : new OpenAiImageGenerator((env as ApiEnv).AI_IMAGE_MODEL, secrets, loadPromptRegistry()),
        },
        {
          provide: AI_IMAGE_ALLOWANCE,
          inject: [AI_BUDGET_GUARD, LlmCallRepository, VALKEY],
          useFactory: (budget: BudgetGuard, ledger: LlmCallRecorder, valkey: Redis) =>
            new LedgerAiImageAllowance(budget, ledger, valkey),
        },
        {
          provide: AI_IMAGE_SETTINGS,
          inject: [APP_ENV],
          useFactory: (appEnv: AppEnv) => {
            const env = appEnv as ApiEnv;
            return {
              dailyCap: env.AI_IMAGES_DAILY_CAP,
              priceUsd: env.AI_IMAGE_PRICE_USD,
              unsplashAppName: env.UNSPLASH_APP_NAME,
            };
          },
        },
        StockAndAiImages,
        { provide: SITE_INSIGHTS, useClass: SiteInsightsReader },
        SiteCommands,
        { provide: GO_LIVE_REPOSITORY, useClass: DrizzleGoLiveRepository },
        GoLiveService,
        { provide: DOMAIN_REPOSITORY, useClass: DrizzleDomainRepository },
        { provide: DNS_RESOLVER, useClass: NodeDnsResolver },
        { provide: DOMAIN_SWEEP_AUTOSTART, useValue: mode === 'worker' },
        DomainsService,
        SiteQueries,
        SiteAssetCommands,
        SiteThumbnailCommands,
        SiteViewAttribution,
        SiteViewRecorder,
        SiteViewsFlusher,
        SiteRenderSubscriber,
        // The worker refreshes the renderer, expires previews, processes images, takes pictures and flushes views;
        // the HTTP process only produces jobs.
        ...(mode === 'worker'
          ? [
              RendererRevalidator,
              SitesRevalidateProcessor,
              SitesExpireProcessor,
              SitesExpiryScheduler,
              { provide: SITES_EXPIRY_AUTOSTART, useValue: true },
              SitesAssetProcessProcessor,
              SitesAssetCollectProcessor,
              SitesAssetAnalyzeProcessor,
              SitesAssetGenerateProcessor,
              SitesScreenshotProcessor,
              SitesViewsFlushProcessor,
              SitesViewsFlushScheduler,
              { provide: SITES_VIEWS_AUTOSTART, useValue: true },
            ]
          : []),
      ],
      exports: [SiteCommands, SiteQueries, SiteAssetCommands, SiteViewAttribution],
    };
  }
}
