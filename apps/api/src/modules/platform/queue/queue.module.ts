import { QUEUE_NAMES, QUEUES } from '@bf/queue';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_ENV, type AppEnv, type AppMode } from '../config/app-env.ts';
import { requirePermission } from '../security/require-permission.middleware.ts';
import { QueueErrorLogger } from './queue-error-logger.ts';

export const BULL_BOARD_ROUTE = '/admin/queues';

/**
 * BullMQ wiring (ADR-0006). Not imported in `openapi` mode: creating a Queue opens a connection.
 * Bull Board is mounted for HTTP, behind the settings:manage permission.
 */
@Module({})
export class QueueModule {
  static forRoot(env: AppEnv, mode: AppMode): DynamicModule {
    const imports = [
      BullModule.forRootAsync({
        inject: [APP_ENV],
        // Options, not an instance: BullMQ then owns (and closes) its connections. Workers need blocking
        // connections; the HTTP process only produces and must fail fast when Valkey is down.
        useFactory: (appEnv: AppEnv) => ({
          connection: { url: appEnv.VALKEY_URL, maxRetriesPerRequest: mode === 'worker' ? null : 1 },
        }),
      }),
      ...QUEUE_NAMES.map((name) =>
        BullModule.registerQueue({ name, defaultJobOptions: QUEUES[name].defaultJobOptions }),
      ),
    ];
    if (mode === 'http') {
      imports.push(
        BullBoardModule.forRoot({
          route: BULL_BOARD_ROUTE,
          adapter: ExpressAdapter,
          // Signed-in operators with settings:manage (credentials resolved by the middleware in http.ts).
          middleware: requirePermission('settings:manage'),
        }),
        ...QUEUE_NAMES.map((name) => BullBoardModule.forFeature({ name, adapter: BullMQAdapter })),
      );
    }
    return {
      module: QueueModule,
      global: true,
      imports,
      providers: [QueueErrorLogger],
      exports: [BullModule],
    };
  }
}
