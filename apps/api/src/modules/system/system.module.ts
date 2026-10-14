import { type DynamicModule, Module } from '@nestjs/common';
import type { AppMode } from '../platform/config/app-env.ts';
import { GetSystemInfoQuery } from './application/get-system-info.query.ts';
import { BUILD_INFO_PROVIDER } from './application/ports.ts';
import { ConfigBuildInfoProvider } from './infrastructure/config-build-info.ts';
import { SystemController } from './interface/system.controller.ts';

/** Reference module: copy its layout for new bounded contexts (`pnpm gen:module`). */
@Module({})
export class SystemModule {
  static forRoot(mode: AppMode): DynamicModule {
    return {
      module: SystemModule,
      controllers: mode === 'worker' ? [] : [SystemController],
      providers: [GetSystemInfoQuery, { provide: BUILD_INFO_PROVIDER, useClass: ConfigBuildInfoProvider }],
    };
  }
}
