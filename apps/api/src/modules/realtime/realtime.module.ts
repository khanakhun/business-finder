import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { AppMode } from '../platform/config/app-env.ts';
import { RealtimePublisher } from './application/realtime-publisher.ts';
import { ConnectionLimiter } from './infrastructure/connection-limiter.ts';
import { RealtimeMultiplexer } from './infrastructure/realtime-multiplexer.ts';
import { RealtimeController } from './interface/realtime.controller.ts';

/**
 * Realtime (BF-012): every process can publish workspace events (`RealtimePublisher`, used by subscribers); the
 * HTTP process serves them over SSE through one multiplexed Valkey subscription.
 */
@Global()
@Module({})
export class RealtimeModule {
  static forRoot(mode: AppMode): DynamicModule {
    const http = mode !== 'worker';
    return {
      module: RealtimeModule,
      controllers: http ? [RealtimeController] : [],
      providers: [RealtimePublisher, ...(http ? [RealtimeMultiplexer, ConnectionLimiter] : [])],
      exports: [RealtimePublisher],
    };
  }
}
