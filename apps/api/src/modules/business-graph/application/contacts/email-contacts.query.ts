import type { VerificationStatus } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import {
  BUSINESS_REPOSITORY,
  type BusinessRepository,
  CONTACT_REPOSITORY,
  type ContactRepository,
} from '../ports.ts';

/** A business's e-mail contact as verification sees it (BF-028). */
export interface EmailContactView {
  readonly id: string;
  readonly businessId: string;
  /** Normalized (lowercase) address. */
  readonly email: string;
  readonly verificationStatus: VerificationStatus;
  readonly verifiedAt: Date | null;
}

/**
 * E-mail contacts for enrichment's verification (BF-028): no workspace check here — callers (the enrichment step,
 * the on-demand command) check that the workspace tracks the business.
 */
@Injectable()
export class EmailContactsQuery {
  constructor(
    @Inject(CONTACT_REPOSITORY) private readonly contacts: ContactRepository,
    @Inject(BUSINESS_REPOSITORY) private readonly businesses: BusinessRepository,
  ) {}

  /** Never-verified addresses first, then the longest-unverified ones. */
  async listForBusiness(businessId: string): Promise<EmailContactView[]> {
    const records = await this.contacts.listByBusiness(businessId);
    return records
      .filter((record) => record.type === 'email')
      .map((record) => ({
        id: record.id,
        businessId: record.businessId,
        email: record.normalizedValue.toLowerCase(),
        verificationStatus: record.verificationStatus,
        verifiedAt: record.verifiedAt,
      }))
      .sort((a, b) => (a.verifiedAt?.getTime() ?? 0) - (b.verifiedAt?.getTime() ?? 0));
  }

  /** Any contact by id, with its business's website host (pattern guessing needs the domain). */
  async find(
    contactId: string,
  ): Promise<{ readonly id: string; readonly businessId: string; readonly type: string } | undefined> {
    const record = await this.contacts.getById(contactId);
    return record ? { id: record.id, businessId: record.businessId, type: record.type } : undefined;
  }

  /** Names of people the business's contacts mention (pattern guessing). */
  personNames(businessId: string, limit = 5): Promise<string[]> {
    return this.contacts.personNames(businessId, limit);
  }

  /** The business's website host, if it has one. */
  async websiteHost(businessId: string): Promise<string | null> {
    return (await this.businesses.getById(businessId))?.snapshot().websiteHost ?? null;
  }
}
