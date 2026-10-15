import { type DynamicModule, Module } from '@nestjs/common';
import { BusinessGraphModule } from '../business-graph/index.ts';
import { GeoModule } from '../geo/index.ts';
import type { AppMode } from '../platform/config/app-env.ts';
import { BusinessEmbedder } from './application/business-embedder.ts';
import { EmbedOnChangeSubscriber } from './application/embed-on-change.subscriber.ts';
import {
  BUSINESS_EMBEDDING_REPOSITORY,
  EMBED_QUEUE,
  type EmbedQueue,
} from './application/embedding-ports.ts';
import {
  BusinessFacetsQuery,
  ListingResolver,
  SearchBusinessesQuery,
} from './application/listing.queries.ts';
import { BUSINESS_SEARCH_REPOSITORY } from './application/listing-ports.ts';
import { SEARCH_INTENT_CACHE } from './application/ports.ts';
import { SearchIntentService } from './application/search-intent.service.ts';
import { BullmqEmbedQueue } from './infrastructure/bullmq-embed-queue.ts';
import { DrizzleBusinessEmbeddingRepository } from './infrastructure/drizzle-business-embedding.repository.ts';
import { DrizzleBusinessSearchRepository } from './infrastructure/drizzle-business-search.repository.ts';
import { ValkeySearchIntentCache } from './infrastructure/valkey-search-intent-cache.ts';
import { BusinessesSearchController } from './interface/http/businesses-search.controller.ts';
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
      controllers: mode === 'worker' ? [] : [SearchController, BusinessesSearchController],
      providers: [
        { provide: SEARCH_INTENT_CACHE, useClass: ValkeySearchIntentCache },
        { provide: BUSINESS_SEARCH_REPOSITORY, useClass: DrizzleBusinessSearchRepository },
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
        ...(mode === 'worker' ? [EmbedBusinessProcessor] : []),
      ],
      exports: [BusinessEmbedder],
    };
  }
}
