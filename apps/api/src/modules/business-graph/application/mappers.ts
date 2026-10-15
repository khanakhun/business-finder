import type { Contact, OrgBusinessState } from '@bf/contracts';
import {
  isDisposableDomain,
  isFreeMailDomain,
  matchesWebsiteDomain,
} from '../domain/value-objects/email-classification.ts';
import type { ContactRecord, OrgBusinessRecord } from './ports.ts';

const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1);

/** A contact as the API shows it; e-mail classification facts are derived from the address (and the site's host). */
export const toContact = (record: ContactRecord, websiteHost: string | null = null): Contact => ({
  id: record.id,
  type: record.type,
  value: record.value,
  normalizedValue: record.normalizedValue,
  subtype: record.subtype,
  personName: record.personName,
  source: record.source,
  sourceUrl: record.sourceUrl,
  publishedOnSite: record.publishedOnSite,
  confidence: record.confidence,
  verificationStatus: record.verificationStatus,
  verifiedAt: record.verifiedAt?.toISOString() ?? null,
  verificationDetails: record.verificationDetails,
  // Stored since BF-028; derived for older rows.
  isFreeMail:
    record.type === 'email'
      ? (record.isFreeMail ?? isFreeMailDomain(domainOf(record.normalizedValue)))
      : null,
  isDisposable: record.type === 'email' ? isDisposableDomain(domainOf(record.normalizedValue)) : null,
  onWebsiteDomain:
    record.type === 'email' ? matchesWebsiteDomain(domainOf(record.normalizedValue), websiteHost) : null,
  publishedContext: record.publishedContext,
  firstSeenAt: record.firstSeenAt.toISOString(),
  lastSeenAt: record.lastSeenAt.toISOString(),
});

export const toOrgBusinessState = (record: OrgBusinessRecord): OrgBusinessState => ({
  pipelineStatus: record.pipelineStatus,
  addedVia: record.addedVia,
  doNotContact: record.doNotContact,
  trackedAt: record.createdAt.toISOString(),
});
