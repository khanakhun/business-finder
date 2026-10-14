import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_ENV, type AppEnv, type AppMode } from './app-env.ts';

export const APP_MODE = Symbol('APP_MODE');

@Global()
@Module({})
export class ConfigModule {
  static forRoot(env: AppEnv, mode: AppMode): DynamicModule {
    return {
      module: ConfigModule,
      providers: [
        { provide: APP_ENV, useValue: env },
        { provide: APP_MODE, useValue: mode },
      ],
      exports: [APP_ENV, APP_MODE],
    };
  }
}
