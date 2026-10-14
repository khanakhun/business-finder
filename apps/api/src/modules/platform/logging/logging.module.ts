import { Global, Module } from '@nestjs/common';
import { APP_ENV, type AppEnv } from '../config/app-env.ts';
import { APP_MODE } from '../config/config.module.ts';
import { createAppLogger, LOGGER } from './logger.ts';

@Global()
@Module({
  providers: [
    {
      provide: LOGGER,
      inject: [APP_ENV, APP_MODE],
      useFactory: (env: AppEnv, mode: string) =>
        createAppLogger(mode === 'worker' ? 'bf-worker' : 'bf-api', env.LOG_LEVEL, env.NODE_ENV),
    },
  ],
  exports: [LOGGER],
})
export class LoggingModule {}
