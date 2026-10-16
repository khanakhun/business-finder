import type { ApiEnv } from '@bf/config';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_ENV, type AppEnv, type AppMode } from '../platform/config/app-env.ts';
import { IntelClient } from '../platform/intel/intel-client.ts';
import { InMemoryObjectStorage, type ObjectStorage } from '../platform/storage/object-storage.ts';
import { S3ObjectStorage } from '../platform/storage/s3-object-storage.ts';
import {
  ASSET_PROCESSING_QUEUE,
  IMAGE_PROCESSOR,
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
import { SiteViewRecorder, SiteViewsFlusher } from './application/site-views.ts';
import { SiteCommands } from './application/sites.commands.ts';
import { SiteQueries } from './application/sites.queries.ts';
import { SiteRenderSubscriber } from './application/sites.subscribers.ts';
import {
  BullmqAssetProcessingQueue,
  BullmqSiteRevalidation,
  BullmqSiteScreenshotQueue,
  OPENAPI_ASSET_QUEUE,
  OPENAPI_SCREENSHOT_QUEUE,
  OPENAPI_SITE_REVALIDATION,
  SITES_EXPIRY_AUTOSTART,
  SITES_VIEWS_AUTOSTART,
  SitesExpiryScheduler,
  SitesViewsFlushScheduler,
} from './infrastructure/bullmq-site-jobs.ts';
import { DrizzleSiteAssetsRepository } from './infrastructure/drizzle-site-assets.repository.ts';
import { DrizzleSiteThumbnailsRepository } from './infrastructure/drizzle-site-thumbnails.repository.ts';
import { DrizzleSiteViewsRepository } from './infrastructure/drizzle-site-views.repository.ts';
import { DrizzleSitesRepository } from './infrastructure/drizzle-sites.repository.ts';
import { FakeSiteScreenshotter, IntelSiteScreenshotter } from './infrastructure/intel-site-screenshotter.ts';
import { RendererRevalidator } from './infrastructure/renderer-revalidator.ts';
import { SharpImageProcessor } from './infrastructure/sharp-image-processor.ts';
import {
  FakeUploadSigner,
  InMemoryPublicFiles,
  S3PublicFiles,
  S3UploadSigner,
} from './infrastructure/site-asset-storage.ts';
import { ValkeySiteViewCounter } from './infrastructure/valkey-site-views.ts';
import { PublicSiteViewsController } from './interface/http/public-site-views.controller.ts';
import { SiteAssetsController } from './interface/http/site-assets.controller.ts';
import { SitesController } from './interface/http/sites.controller.ts';
import {
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
        mode === 'worker' ? [] : [SitesController, SiteAssetsController, PublicSiteViewsController],
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
              { provide: SITE_SCREENSHOT_QUEUE, useValue: OPENAPI_SCREENSHOT_QUEUE },
              { provide: SITE_ORIGINALS, useValue: new InMemoryObjectStorage() },
              { provide: SITE_ARTIFACTS, useValue: new InMemoryObjectStorage() },
              { provide: PUBLIC_FILES, useValue: new InMemoryPublicFiles() },
              { provide: UPLOAD_SIGNER, useValue: new FakeUploadSigner() },
            ]
          : [
              { provide: SITE_REVALIDATION, useClass: BullmqSiteRevalidation },
              { provide: ASSET_PROCESSING_QUEUE, useClass: BullmqAssetProcessingQueue },
              { provide: SITE_SCREENSHOT_QUEUE, useClass: BullmqSiteScreenshotQueue },
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
            return {
              baseDomain: api.SITES_BASE_DOMAIN,
              assetHosts: [new URL(api.SITES_ASSETS_BASE_URL).hostname],
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
        { provide: SITE_INSIGHTS, useClass: SiteInsightsReader },
        SiteCommands,
        SiteQueries,
        SiteAssetCommands,
        SiteThumbnailCommands,
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
              SitesScreenshotProcessor,
              SitesViewsFlushProcessor,
              SitesViewsFlushScheduler,
              { provide: SITES_VIEWS_AUTOSTART, useValue: true },
            ]
          : []),
      ],
      exports: [SiteCommands, SiteQueries],
    };
  }
}
