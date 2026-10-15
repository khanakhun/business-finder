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
import { DrizzleBusinessRepository } from './infrastructure/drizzle-business.repository.ts';
import { DrizzleBusinessReadModel } from './infrastructure/drizzle-business-read-model.ts';
import { DrizzleContactRepository } from './infrastructure/drizzle-contact.repository.ts';
import { DrizzleOrgBusinessRepository } from './infrastructure/drizzle-org-business.repository.ts';
import { DrizzleSourceRecordRepository } from './infrastructure/drizzle-source-record.repository.ts';
import { BusinessesController } from './interface/businesses.controller.ts';

/**
 * Business graph (BF-014): global golden records with provenance, their sources and contacts, and the workspace's
 * link to them (`org_businesses`, until the CRM module exists — BF-024).
 */
@Module({})
export class BusinessGraphModule {
  static forRoot(mode: AppMode): DynamicModule {
    return {
      module: BusinessGraphModule,
      controllers: mode === 'worker' ? [] : [BusinessesController],
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
      ],
      exports: [BUSINESS_REPOSITORY, SOURCE_RECORD_REPOSITORY, ORG_BUSINESS_REPOSITORY],
    };
  }
}
