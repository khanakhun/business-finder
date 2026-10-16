import { type BusinessDetail, type ContactList, NotFoundError } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { toContact } from './mappers.ts';
import {
  BUSINESS_READ_MODEL,
  type BusinessReadModel,
  CONTACT_REPOSITORY,
  type ContactRepository,
  ORG_BUSINESS_REPOSITORY,
  type OrgBusinessRepository,
} from './ports.ts';
import { workspaceOf } from './workspace-of.ts';

/** Global facts plus the workspace's state; 404 unless the workspace tracks the business (ADR-0008). */
@Injectable()
export class GetBusinessDetailQuery {
  constructor(@Inject(BUSINESS_READ_MODEL) private readonly read: BusinessReadModel) {}

  async execute(auth: AuthContext, businessId: string): Promise<BusinessDetail> {
    const detail = await this.read.detail(workspaceOf(auth), businessId);
    if (!detail) throw new NotFoundError('Business', businessId);
    return detail;
  }
}

/** The workspace's businesses, most recently tracked first (filters and ranking come with search, BF-022). */
@Injectable()
export class ListContactsQuery {
  constructor(
    @Inject(ORG_BUSINESS_REPOSITORY) private readonly orgBusinesses: OrgBusinessRepository,
    @Inject(CONTACT_REPOSITORY) private readonly contacts: ContactRepository,
  ) {}

  async execute(auth: AuthContext, businessId: string): Promise<ContactList> {
    if (!(await this.orgBusinesses.find(workspaceOf(auth), businessId))) {
      throw new NotFoundError('Business', businessId);
    }
    const records = await this.contacts.listByBusiness(businessId);
    return { items: records.map(toContact) };
  }
}
