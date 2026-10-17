import type { ApiEnv } from '@bf/config';
import { type DynamicModule, Module } from '@nestjs/common';
import { GenerationModule } from '../generation/index.ts';
import { APP_ENV, type AppEnv, type AppMode } from '../platform/config/app-env.ts';
import { SitesModule } from '../sites/index.ts';
import { SITE_CHAT_REPOSITORY } from './application/ports.ts';
import { SiteChatProposals } from './application/site-chat.proposals.ts';
import { SITE_CHAT_RETENTION_DAYS, SiteChatRetention } from './application/site-chat.retention.ts';
import { DrizzleSiteChatRepository } from './infrastructure/drizzle-site-chat.repository.ts';
import { SiteChatController } from './interface/http/site-chat.controller.ts';

/**
 * Chat-based site editing (BF-047): threads, the edit agent's proposals, apply and discard. Its own context: it
 * edits sites (sites module) and states workspace facts (generation module's fact registry).
 */
@Module({})
export class SiteChatModule {
  static forRoot(mode: AppMode): DynamicModule {
    return {
      module: SiteChatModule,
      imports: [SitesModule.forRoot(mode), GenerationModule.forRoot(mode)],
      controllers: mode === 'worker' ? [] : [SiteChatController],
      providers: [
        { provide: SITE_CHAT_REPOSITORY, useClass: DrizzleSiteChatRepository },
        {
          provide: SITE_CHAT_RETENTION_DAYS,
          inject: [APP_ENV],
          useFactory: (env: AppEnv) => (env as ApiEnv).SITE_CHAT_RETENTION_DAYS,
        },
        SiteChatProposals,
        ...(mode === 'worker' ? [SiteChatRetention] : []),
      ],
    };
  }
}
