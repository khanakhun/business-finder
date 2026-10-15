import { type DynamicModule, Module } from '@nestjs/common';
import { BusinessGraphModule } from '../business-graph/index.ts';
import { GeoModule } from '../geo/index.ts';
import type { AppMode } from '../platform/config/app-env.ts';
import { SEARCH_INTENT_CACHE } from './application/ports.ts';
import { SearchIntentService } from './application/search-intent.service.ts';
import { ValkeySearchIntentCache } from './infrastructure/valkey-search-intent-cache.ts';
import { SearchController } from './interface/http/search.controller.ts';

/** Search (BF-021…BF-023): intent parsing now; hybrid search and saved searches later. */
@Module({})
export class SearchModule {
  static forRoot(mode: AppMode): DynamicModule {
    return {
      module: SearchModule,
      imports: [BusinessGraphModule.forRoot(mode), GeoModule.forRoot(mode)],
      controllers: mode === 'worker' ? [] : [SearchController],
      providers: [{ provide: SEARCH_INTENT_CACHE, useClass: ValkeySearchIntentCache }, SearchIntentService],
    };
  }
}
