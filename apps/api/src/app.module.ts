import { type DynamicModule, Module } from '@nestjs/common';
import type { AppEnv, AppMode } from './modules/platform/config/app-env.ts';
import { PlatformModule } from './modules/platform/platform.module.ts';
import { SystemModule } from './modules/system/system.module.ts';

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
    return { module: AppModule, imports: [PlatformModule.forRoot(env, mode), SystemModule.forRoot(mode)] };
  }
}
