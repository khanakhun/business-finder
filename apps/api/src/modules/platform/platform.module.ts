import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { TerminusModule } from '@nestjs/terminus';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { ClockModule } from './clock/clock.module.ts';
import type { AppEnv, AppMode } from './config/app-env.ts';
import { ConfigModule } from './config/config.module.ts';
import { getRequestContext, RequestContextMiddleware } from './context/request-context.ts';
import { DbModule } from './db/db.module.ts';
import { ProblemDetailsFilter } from './errors/problem-details.filter.ts';
import { HealthController } from './health/health.controller.ts';
import { HttpLoggingMiddleware, LOGGER, type Logger } from './logging/logger.ts';
import { LoggingModule } from './logging/logging.module.ts';
import { MetricsController } from './metrics/metrics.controller.ts';
import { AuthorizationGuard } from './security/authorization.guard.ts';
import { AppThrottlerGuard, RATE_LIMITS } from './security/throttler.guard.ts';
import { ValkeyThrottlerStorage } from './security/valkey-throttler.storage.ts';
import { ResponseValidationInterceptor } from './validation/response-validation.interceptor.ts';
import { ZodValidationPipe } from './validation/zod-validation.pipe.ts';
import { VALKEY, ValkeyModule } from './valkey/valkey.module.ts';

/**
 * Shared kernel: configuration, clients, cross-cutting HTTP behaviour. Imported once by AppModule; the mode
 * decides whether HTTP pieces (controllers, guards, middleware) are wired.
 */
@Module({})
export class PlatformModule implements NestModule {
  static forRoot(env: AppEnv, mode: AppMode): DynamicModule {
    const shared = [ConfigModule.forRoot(env, mode), LoggingModule, DbModule, ValkeyModule, ClockModule];
    if (mode === 'worker') return { module: PlatformModule, imports: shared };
    return {
      module: PlatformModule,
      imports: [
        ...shared,
        TerminusModule.forRoot({ gracefulShutdownTimeoutMs: 0 }),
        ThrottlerModule.forRootAsync({
          inject: [VALKEY, LOGGER],
          useFactory: (valkey: Redis, logger: Logger) => ({
            throttlers: [
              {
                name: 'default',
                ttl: RATE_LIMITS.windowMs,
                limit: () => (getRequestContext()?.auth ? RATE_LIMITS.authenticated : RATE_LIMITS.anonymous),
              },
            ],
            storage: new ValkeyThrottlerStorage(valkey, logger),
          }),
        }),
      ],
      controllers: [HealthController, MetricsController],
      providers: [
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        { provide: APP_INTERCEPTOR, useClass: ResponseValidationInterceptor },
        { provide: APP_GUARD, useClass: AppThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthorizationGuard },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware, HttpLoggingMiddleware).forRoutes('*');
  }
}
