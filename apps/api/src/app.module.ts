import { type DynamicModule, Module } from '@nestjs/common';
import { BusinessGraphModule } from './modules/business-graph/index.ts';
import { CrmModule } from './modules/crm/index.ts';
import { DiscoveryModule } from './modules/discovery/index.ts';
import { EnrichmentModule } from './modules/enrichment/index.ts';
import { GeoModule } from './modules/geo/index.ts';
import { IdentityModule } from './modules/identity/identity.module.ts';
import { AiModule } from './modules/platform/ai/ai.module.ts';
import type { AppEnv, AppMode } from './modules/platform/config/app-env.ts';
import { EventsModule } from './modules/platform/events/events.module.ts';
import { PlatformModule } from './modules/platform/platform.module.ts';
import { QueueModule } from './modules/platform/queue/queue.module.ts';
import { RealtimeModule } from './modules/realtime/realtime.module.ts';
import { SearchModule } from './modules/search/index.ts';
import { SystemModule } from './modules/system/system.module.ts';
import { WorkspaceModule } from './modules/workspace/workspace.module.ts';

/** Composition root. Each process type gets the same domain modules wired for its role (ADR-0005). */
@Module({})
export class AppModule {
  static forHttp(env: AppEnv): DynamicModule {
    return AppModule.build(env, 'http');
  }

  static forWorker(env: AppEnv): DynamicModule {
    return AppModule.build(env, 'worker');
  }

  /** HTTP wiring with no connections made: for OpenAPI generation. */
  static forOpenApi(env: AppEnv): DynamicModule {
    return AppModule.build(env, 'openapi');
  }

  private static build(env: AppEnv, mode: AppMode): DynamicModule {
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(env, mode),
        // Creating queues connects to Valkey, which OpenAPI generation must never do.
        ...(mode === 'openapi' ? [] : [QueueModule.forRoot(mode)]),
        EventsModule.forRoot(mode),
        WorkspaceModule.forRoot(mode),
        AiModule.forRoot(mode),
        RealtimeModule.forRoot(mode),
        IdentityModule.forRoot(mode),
        SystemModule.forRoot(mode),
        // Before BusinessGraphModule: Express matches routes in registration order, and the listing's
        // `GET /businesses/facets` (search) must win over `GET /businesses/:id` (business graph).
        SearchModule.forRoot(mode),
        // Before BusinessGraphModule too: `businesses/bulk/*` must win over `businesses/:id/*` routes.
        CrmModule.forRoot(mode),
        BusinessGraphModule.forRoot(mode),
        GeoModule.forRoot(mode),
        DiscoveryModule.forRoot(mode),
        EnrichmentModule.forRoot(mode),
      ],
    };
  }
}
