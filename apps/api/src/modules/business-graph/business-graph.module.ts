import { type DynamicModule, Module } from '@nestjs/common';
import type { AppMode } from '../platform/config/app-env.ts';
import {
  AddContactCommand,
  CreateManualBusinessCommand,
  TrackBusinessCommand,
} from './application/business.commands.ts';
import {
  GetBusinessDetailQuery,
  ListContactsQuery,
  ListTrackedBusinessesQuery,
} from './application/business.queries.ts';
import {
  BUSINESS_READ_MODEL,
  BUSINESS_REPOSITORY,
  CONTACT_REPOSITORY,
  ORG_BUSINESS_REPOSITORY,
  SOURCE_RECORD_REPOSITORY,
} from './application/ports.ts';
import { CategoryCandidateSearch } from './application/taxonomy/category-candidates.ts';
import { CategoryClassifier } from './application/taxonomy/category-classifier.ts';
import { CategoryEmbedder } from './application/taxonomy/category-embedder.ts';
import { TAXONOMY_REPOSITORY } from './application/taxonomy/ports.ts';
import { ReviewCategoryMappingCommand } from './application/taxonomy/taxonomy.commands.ts';
import {
  GetCategoryTreeQuery,
  ListCategoryMappingsQuery,
  SearchCategoriesQuery,
} from './application/taxonomy/taxonomy.queries.ts';
import { TaxonomyCache } from './application/taxonomy/taxonomy-cache.ts';
import { DrizzleBusinessRepository } from './infrastructure/drizzle-business.repository.ts';
import { DrizzleBusinessReadModel } from './infrastructure/drizzle-business-read-model.ts';
import { DrizzleContactRepository } from './infrastructure/drizzle-contact.repository.ts';
import { DrizzleOrgBusinessRepository } from './infrastructure/drizzle-org-business.repository.ts';
import { DrizzleSourceRecordRepository } from './infrastructure/drizzle-source-record.repository.ts';
import { DrizzleTaxonomyRepository } from './infrastructure/taxonomy/drizzle-taxonomy.repository.ts';
import { TaxonomyEmbedScheduler } from './infrastructure/taxonomy/taxonomy-embed.scheduler.ts';
import { BusinessesController } from './interface/businesses.controller.ts';
import { CategoriesController } from './interface/taxonomy/categories.controller.ts';
import { TaxonomyEmbedProcessor } from './interface/taxonomy/taxonomy-embed.processor.ts';

/**
 * Business graph (BF-014): global golden records with provenance, their sources and contacts, and the workspace's
 * link to them (`org_businesses`, until the CRM module exists — BF-024); the category taxonomy and classifier
 * (BF-015).
 */
@Module({})
export class BusinessGraphModule {
  static forRoot(mode: AppMode): DynamicModule {
    return {
      module: BusinessGraphModule,
      controllers: mode === 'worker' ? [] : [BusinessesController, CategoriesController],
      providers: [
        GetBusinessDetailQuery,
        ListTrackedBusinessesQuery,
        ListContactsQuery,
        CreateManualBusinessCommand,
        TrackBusinessCommand,
        AddContactCommand,
        DrizzleContactRepository,
        { provide: BUSINESS_REPOSITORY, useClass: DrizzleBusinessRepository },
        { provide: CONTACT_REPOSITORY, useExisting: DrizzleContactRepository },
        { provide: SOURCE_RECORD_REPOSITORY, useClass: DrizzleSourceRecordRepository },
        { provide: ORG_BUSINESS_REPOSITORY, useClass: DrizzleOrgBusinessRepository },
        { provide: BUSINESS_READ_MODEL, useClass: DrizzleBusinessReadModel },
        // Taxonomy (BF-015)
        { provide: TAXONOMY_REPOSITORY, useClass: DrizzleTaxonomyRepository },
        TaxonomyCache,
        CategoryCandidateSearch,
        CategoryClassifier,
        CategoryEmbedder,
        GetCategoryTreeQuery,
        SearchCategoriesQuery,
        ListCategoryMappingsQuery,
        ReviewCategoryMappingCommand,
        ...(mode === 'worker' ? [TaxonomyEmbedProcessor, TaxonomyEmbedScheduler] : []),
      ],
      exports: [
        BUSINESS_REPOSITORY,
        SOURCE_RECORD_REPOSITORY,
        ORG_BUSINESS_REPOSITORY,
        CategoryClassifier,
        CategoryCandidateSearch,
      ],
    };
  }
}
