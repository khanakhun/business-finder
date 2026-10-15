import { type DynamicModule, Module } from '@nestjs/common';
import type { AppMode } from '../platform/config/app-env.ts';
import { RealtimeModule } from '../realtime/index.ts';
import { ActivitySubscriber } from './application/activity.subscriber.ts';
import { CrmQueries } from './application/crm.queries.ts';
import { CrmPipeline, CrmService } from './application/crm.service.ts';
import { CRM_REPOSITORY } from './application/ports.ts';
import { DrizzleCrmRepository } from './infrastructure/drizzle-crm.repository.ts';
import { CrmController } from './interface/http/crm.controller.ts';

/** CRM basics (BF-024): pipeline, owner, tags, do-not-contact, notes, tasks, activity timeline, board. */
@Module({})
export class CrmModule {
  static forRoot(mode: AppMode): DynamicModule {
    return {
      module: CrmModule,
      imports: [RealtimeModule.forRoot(mode)],
      controllers: mode === 'worker' ? [] : [CrmController],
      providers: [
        { provide: CRM_REPOSITORY, useClass: DrizzleCrmRepository },
        CrmService,
        CrmPipeline,
        CrmQueries,
        ActivitySubscriber,
      ],
      exports: [CrmPipeline],
    };
  }
}
