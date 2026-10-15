import type { Contact, OrgBusinessState } from '@bf/contracts';
import type { ContactRecord, OrgBusinessRecord } from './ports.ts';

export const toContact = (record: ContactRecord): Contact => ({
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
  isFreeMail: record.isFreeMail,
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
