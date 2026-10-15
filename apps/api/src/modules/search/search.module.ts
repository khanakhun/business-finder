import { type DynamicModule, Module } from '@nestjs/common';
import { BusinessGraphModule } from '../business-graph/index.ts';
import { GeoModule } from '../geo/index.ts';
import type { AppMode } from '../platform/config/app-env.ts';
import {
  BusinessFacetsQuery,
  ListingResolver,
  SearchBusinessesQuery,
} from './application/listing.queries.ts';
import { BUSINESS_SEARCH_REPOSITORY } from './application/listing-ports.ts';
import { SEARCH_INTENT_CACHE } from './application/ports.ts';
import { SearchIntentService } from './application/search-intent.service.ts';
import { DrizzleBusinessSearchRepository } from './infrastructure/drizzle-business-search.repository.ts';
import { ValkeySearchIntentCache } from './infrastructure/valkey-search-intent-cache.ts';
import { BusinessesSearchController } from './interface/http/businesses-search.controller.ts';
import { SearchController } from './interface/http/search.controller.ts';

/** Search (BF-021…BF-023): intent parsing, the hybrid listing and its facets. */
@Module({})
export class SearchModule {
  static forRoot(mode: AppMode): DynamicModule {
    return {
      module: SearchModule,
      imports: [BusinessGraphModule.forRoot(mode), GeoModule.forRoot(mode)],
      controllers: mode === 'worker' ? [] : [SearchController, BusinessesSearchController],
      providers: [
        { provide: SEARCH_INTENT_CACHE, useClass: ValkeySearchIntentCache },
        { provide: BUSINESS_SEARCH_REPOSITORY, useClass: DrizzleBusinessSearchRepository },
        SearchIntentService,
        ListingResolver,
        SearchBusinessesQuery,
        BusinessFacetsQuery,
      ],
    };
  }
}
