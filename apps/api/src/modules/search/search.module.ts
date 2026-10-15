import { type DynamicModule, Module } from '@nestjs/common';
import { BusinessGraphModule } from '../business-graph/index.ts';
import { GeoModule } from '../geo/index.ts';
import type { AppMode } from '../platform/config/app-env.ts';
import { BusinessEmbedder } from './application/business-embedder.ts';
import { LIST_REPOSITORY, SAVED_SEARCH_REPOSITORY } from './application/collection-ports.ts';
import { BusinessLists, SavedSearches } from './application/collections.ts';
import { EmbedOnChangeSubscriber } from './application/embed-on-change.subscriber.ts';
import {
  BUSINESS_EMBEDDING_REPOSITORY,
  EMBED_QUEUE,
  type EmbedQueue,
} from './application/embedding-ports.ts';
import { ExportBusinesses } from './application/export-businesses.ts';
import {
  BusinessFacetsQuery,
  ListingResolver,
  SearchBusinessesQuery,
} from './application/listing.queries.ts';
import { BUSINESS_SEARCH_REPOSITORY, RANKING_CACHE } from './application/listing-ports.ts';
import { SEARCH_INTENT_CACHE } from './application/ports.ts';
import { SearchIntentService } from './application/search-intent.service.ts';
import { BullmqEmbedQueue } from './infrastructure/bullmq-embed-queue.ts';
import { DrizzleBusinessEmbeddingRepository } from './infrastructure/drizzle-business-embedding.repository.ts';
import { DrizzleBusinessSearchRepository } from './infrastructure/drizzle-business-search.repository.ts';
import {
  DrizzleListRepository,
  DrizzleSavedSearchRepository,
} from './infrastructure/drizzle-collections.repository.ts';
import { ValkeyRankingCache } from './infrastructure/valkey-ranking-cache.ts';
import { ValkeySearchIntentCache } from './infrastructure/valkey-search-intent-cache.ts';
import { BusinessesSearchController } from './interface/http/businesses-search.controller.ts';
import { ListsController } from './interface/http/lists.controller.ts';
import { SavedSearchesController } from './interface/http/saved-searches.controller.ts';
import { SearchController } from './interface/http/search.controller.ts';
import { EmbedBusinessProcessor } from './interface/processors/embed-business.processor.ts';

const OPENAPI_EMBED_QUEUE: EmbedQueue = {
  enqueue: () => Promise.reject(new Error('no queue in openapi mode')),
};

/** Search (BF-021…BF-023): intent parsing, the hybrid listing, its facets and business embeddings. */
@Module({})
export class SearchModule {
  static forRoot(mode: AppMode): DynamicModule {
    return {
      module: SearchModule,
      imports: [BusinessGraphModule.forRoot(mode), GeoModule.forRoot(mode)],
      controllers:
        mode === 'worker'
          ? []
          : [SearchController, BusinessesSearchController, SavedSearchesController, ListsController],
      providers: [
        { provide: SEARCH_INTENT_CACHE, useClass: ValkeySearchIntentCache },
        { provide: BUSINESS_SEARCH_REPOSITORY, useClass: DrizzleBusinessSearchRepository },
        { provide: RANKING_CACHE, useClass: ValkeyRankingCache },
        SearchIntentService,
        ListingResolver,
        SearchBusinessesQuery,
        BusinessFacetsQuery,
        { provide: BUSINESS_EMBEDDING_REPOSITORY, useClass: DrizzleBusinessEmbeddingRepository },
        mode === 'openapi'
          ? { provide: EMBED_QUEUE, useValue: OPENAPI_EMBED_QUEUE }
          : { provide: EMBED_QUEUE, useClass: BullmqEmbedQueue },
        BusinessEmbedder,
        EmbedOnChangeSubscriber,
        { provide: SAVED_SEARCH_REPOSITORY, useClass: DrizzleSavedSearchRepository },
        { provide: LIST_REPOSITORY, useClass: DrizzleListRepository },
        SavedSearches,
        BusinessLists,
        ExportBusinesses,
        ...(mode === 'worker' ? [EmbedBusinessProcessor] : []),
      ],
      exports: [BusinessEmbedder],
    };
  }
}
