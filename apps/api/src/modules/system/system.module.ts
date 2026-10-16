import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import type { AppMode } from '../platform/config/app-env.ts';
import { EnqueuePingJobsCommand } from './application/enqueue-ping-jobs.command.ts';
import { GetSystemInfoQuery } from './application/get-system-info.query.ts';
import { BUILD_INFO_PROVIDER, PING_JOB_QUEUE } from './application/ports.ts';
import { BullPingJobQueue } from './infrastructure/bull-ping-job.queue.ts';
import { ConfigBuildInfoProvider } from './infrastructure/config-build-info.ts';
import { SystemController } from './interface/system.controller.ts';
import { SystemPingProcessor } from './interface/system-ping.processor.ts';

/**
 * Reference module: copy its layout for new bounded contexts (`pnpm gen:module`).
 * HTTP gets controllers + producers, the worker gets processors, openapi gets controllers with stub adapters.
 */
@Module({})
export class SystemModule {
  static forRoot(mode: AppMode): DynamicModule {
    const pingQueue: Provider =
      mode === 'openapi'
        ? {
            provide: PING_JOB_QUEUE,
            useValue: { enqueue: () => Promise.reject(new Error('no queue in openapi mode')) },
          }
        : { provide: PING_JOB_QUEUE, useClass: BullPingJobQueue };
    return {
      module: SystemModule,
      controllers: mode === 'worker' ? [] : [SystemController],
      providers: [
        GetSystemInfoQuery,
        EnqueuePingJobsCommand,
        { provide: BUILD_INFO_PROVIDER, useClass: ConfigBuildInfoProvider },
        pingQueue,
        ...(mode === 'worker' ? [SystemPingProcessor] : []),
      ],
    };
  }
}
