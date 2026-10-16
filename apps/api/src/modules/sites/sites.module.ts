import type { ApiEnv } from '@bf/config';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_ENV, type AppEnv, type AppMode } from '../platform/config/app-env.ts';
import { SITE_HOSTING, SITE_REVALIDATION, SITES_REPOSITORY, type SiteHosting } from './application/ports.ts';
import { SiteCommands } from './application/sites.commands.ts';
import { SiteQueries } from './application/sites.queries.ts';
import {
  BullmqSiteRevalidation,
  OPENAPI_SITE_REVALIDATION,
  SITES_EXPIRY_AUTOSTART,
  SitesExpiryScheduler,
} from './infrastructure/bullmq-site-jobs.ts';
import { DrizzleSitesRepository } from './infrastructure/drizzle-sites.repository.ts';
import { RendererRevalidator } from './infrastructure/renderer-revalidator.ts';
import { SitesController } from './interface/http/sites.controller.ts';
import { SitesExpireProcessor, SitesRevalidateProcessor } from './interface/processors/sites.processors.ts';

/**
 * Sites (BF-035): sites, immutable versions and publications, the renderer's revalidation and the preview expiry.
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
      controllers: mode === 'worker' ? [] : [SitesController],
      providers: [
        { provide: SITES_REPOSITORY, useClass: DrizzleSitesRepository },
        mode === 'openapi'
          ? { provide: SITE_REVALIDATION, useValue: OPENAPI_SITE_REVALIDATION }
          : { provide: SITE_REVALIDATION, useClass: BullmqSiteRevalidation },
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
        SiteCommands,
        SiteQueries,
        // The worker refreshes the renderer and expires previews; the HTTP process only produces jobs.
        ...(mode === 'worker'
          ? [
              RendererRevalidator,
              SitesRevalidateProcessor,
              SitesExpireProcessor,
              SitesExpiryScheduler,
              { provide: SITES_EXPIRY_AUTOSTART, useValue: true },
            ]
          : []),
      ],
      exports: [SiteCommands, SiteQueries],
    };
  }
}
