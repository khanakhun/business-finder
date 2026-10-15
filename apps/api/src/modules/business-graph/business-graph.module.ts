import { type DynamicModule, Module } from '@nestjs/common';
import type { AppMode } from '../platform/config/app-env.ts';
import {
  AddContactCommand,
  CreateManualBusinessCommand,
  TrackBusinessCommand,
} from './application/business.commands.ts';
import { GetBusinessDetailQuery, ListContactsQuery } from './application/business.queries.ts';
import { RecordEmailVerificationCommand } from './application/contacts/record-email-verification.command.ts';
import {
  ReplaceWebsiteMediaCommand,
  WEBSITE_MEDIA_REPOSITORY,
} from './application/media/replace-website-media.command.ts';
import {
  BUSINESS_READ_MODEL,
  BUSINESS_REPOSITORY,
  CONTACT_REPOSITORY,
  ORG_BUSINESS_REPOSITORY,
  SOURCE_RECORD_REPOSITORY,
} from './application/ports.ts';
import { GoldenRecordWriter } from './application/resolution/golden-record.writer.ts';
import { IngestBatchCommand } from './application/resolution/ingest-batch.command.ts';
import { IngestSourceRecordCommand } from './application/resolution/ingest-source-record.command.ts';
import {
  ListPossibleDuplicatesQuery,
  MergeBusinessesCommand,
  ResolvePossibleDuplicateCommand,
  SplitBusinessCommand,
} from './application/resolution/merge.commands.ts';
import { MERGE_REPOSITORY, RESOLUTION_REPOSITORY } from './application/resolution/ports.ts';
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
import { DrizzleWebsiteMediaRepository } from './infrastructure/media/drizzle-website-media.repository.ts';
import { DrizzleMergeRepository } from './infrastructure/resolution/drizzle-merge.repository.ts';
import { DrizzleResolutionRepository } from './infrastructure/resolution/drizzle-resolution.repository.ts';
import { DrizzleTaxonomyRepository } from './infrastructure/taxonomy/drizzle-taxonomy.repository.ts';
import { TaxonomyEmbedScheduler } from './infrastructure/taxonomy/taxonomy-embed.scheduler.ts';
import { BusinessesController } from './interface/businesses.controller.ts';
import { ResolutionController } from './interface/resolution.controller.ts';
import { CategoriesController } from './interface/taxonomy/categories.controller.ts';
import { TaxonomyEmbedProcessor } from './interface/taxonomy/taxonomy-embed.processor.ts';

/**
 * Business graph (BF-014): global golden records with provenance, their sources and contacts, and the workspace's
 * link to them (`org_businesses`, until the CRM module exists — BF-024); the category taxonomy and classifier
 * (BF-015).
 */
@Module({})
export class BusinessGraphModule {
  private static readonly byMode = new Map<AppMode, DynamicModule>();

  /**
   * One definition per mode: modules importing this one (for its public services) share the instance the app
   * module creates instead of building a second one.
   */
  static forRoot(mode: AppMode): DynamicModule {
    let definition = BusinessGraphModule.byMode.get(mode);
    if (!definition) {
      definition = BusinessGraphModule.build(mode);
      BusinessGraphModule.byMode.set(mode, definition);
    }
    return definition;
  }

  private static build(mode: AppMode): DynamicModule {
    return {
      module: BusinessGraphModule,
      // ResolutionController first: its static paths (`possible-duplicates`, `merge`) must win over `:id`.
      controllers:
        mode === 'worker' ? [] : [ResolutionController, BusinessesController, CategoriesController],
      providers: [
        GetBusinessDetailQuery,
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
        // Entity resolution (BF-016)
        { provide: RESOLUTION_REPOSITORY, useClass: DrizzleResolutionRepository },
        GoldenRecordWriter,
        IngestSourceRecordCommand,
        ReplaceWebsiteMediaCommand,
        RecordEmailVerificationCommand,
        { provide: WEBSITE_MEDIA_REPOSITORY, useClass: DrizzleWebsiteMediaRepository },
        IngestBatchCommand,
        { provide: MERGE_REPOSITORY, useClass: DrizzleMergeRepository },
        MergeBusinessesCommand,
        SplitBusinessCommand,
        ListPossibleDuplicatesQuery,
        ResolvePossibleDuplicateCommand,
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
        IngestSourceRecordCommand,
        ReplaceWebsiteMediaCommand,
        RecordEmailVerificationCommand,
        IngestBatchCommand,
      ],
    };
  }
}
