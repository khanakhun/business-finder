import type { AddedVia, BusinessDetail, ContactType, PipelineStatus, SourceProvider } from '@bf/contracts';
import type { Business } from '../domain/business.entity.ts';
import type { BusinessContactProps } from '../domain/business-contact.ts';

// Ports of the business-graph module. Adapters call getExecutor(db), so use cases control transactions.

/** Golden records (the `Business` aggregate with the contacts it adds). */
export interface BusinessRepository {
  getById(id: string): Promise<Business | undefined>;
  getByIds(ids: readonly string[]): Promise<Business[]>;
  /** The record a provider's record is linked to. */
  findBySourceRef(provider: SourceProvider, providerRef: string): Promise<Business | undefined>;
  /**
   * Inserts a new aggregate, or updates it when its stored `version` still matches (then increments it); writes the
   * contacts it added. Throws `ConcurrentModificationError` on a stale version.
   */
  save(business: Business): Promise<void>;
}
export const BUSINESS_REPOSITORY = Symbol('BusinessRepository');

export interface ContactRecord extends BusinessContactProps {
  readonly verificationStatus: 'unknown' | 'valid' | 'invalid' | 'catch_all' | 'risky' | 'disposable';
  readonly verifiedAt: Date | null;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

export interface ContactRepository {
  listByBusiness(businessId: string): Promise<ContactRecord[]>;
  find(businessId: string, type: ContactType, normalizedValue: string): Promise<ContactRecord | undefined>;
}
export const CONTACT_REPOSITORY = Symbol('ContactRepository');

export interface NewSourceRecord {
  readonly id: string;
  readonly businessId: string | null;
  readonly provider: SourceProvider;
  readonly providerRef: string;
  /** The provider's raw data: untrusted, never rendered or prompted unquoted. */
  readonly payload: unknown;
  readonly normalized: Record<string, unknown> | null;
  readonly contentHash: string;
  readonly fetchedAt: Date;
  readonly expiresAt: Date | null;
  readonly matchConfidence: number | null;
  readonly linkedBy: 'auto' | 'manual';
  /** The workspace that entered a `manual` record (attribution only). */
  readonly submittedByOrgId?: string | null;
}

export interface SourceRecord extends NewSourceRecord {
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SourceRecordRepository {
  /**
   * Inserts or refreshes the record for (`provider`, `providerRef`). `changed` is false when the content hash is the
   * same (only `fetchedAt`/`expiresAt` move), so ingestion can stop early (BF-016).
   */
  upsert(record: NewSourceRecord): Promise<{ readonly record: SourceRecord; readonly changed: boolean }>;
  findByProviderRef(provider: SourceProvider, providerRef: string): Promise<SourceRecord | undefined>;
  listByBusiness(businessId: string): Promise<SourceRecord[]>;
}
export const SOURCE_RECORD_REPOSITORY = Symbol('SourceRecordRepository');

export interface OrgBusinessRecord {
  readonly organizationId: string;
  readonly businessId: string;
  readonly pipelineStatus: PipelineStatus;
  readonly addedVia: AddedVia;
  readonly addedRef: string | null;
  readonly doNotContact: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The workspace's link to businesses (`org_businesses`, crm). */
export interface OrgBusinessRepository {
  /** Idempotent: an existing link is returned unchanged (`created: false`). */
  track(input: {
    readonly organizationId: string;
    readonly businessId: string;
    readonly addedVia: AddedVia;
    readonly addedRef: string | null;
  }): Promise<{ readonly record: OrgBusinessRecord; readonly created: boolean }>;
  find(organizationId: string, businessId: string): Promise<OrgBusinessRecord | undefined>;
}
export const ORG_BUSINESS_REPOSITORY = Symbol('OrgBusinessRepository');

/** Read side (CQRS-lite): joins global facts with the workspace's state. */
export interface BusinessReadModel {
  /** Undefined unless the workspace tracks the business. */
  detail(organizationId: string, businessId: string): Promise<BusinessDetail | undefined>;
}
export const BUSINESS_READ_MODEL = Symbol('BusinessReadModel');
