// Outreach compliance (BF-049): versioned policies (global seeds, stricter workspace overrides) and each workspace's
// review of them, the append-only decision log, the append-only suppression log with its current-state projection,
// lawful-basis records and the offer ↔ category relevance seed. Append-only tables are protected by triggers.

import type {
  ComplianceDecisionValue,
  ComplianceStage,
  DecisionReason,
  EvaluationInputs,
  OutreachChannel,
  PolicyDocument,
  RequiredElement,
  SuppressionReason,
  SuppressionScope,
  SuppressionSource,
} from '@bf/contracts';

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from '../columns.ts';
import { organization, user } from './auth.ts';
import { businesses } from './business-graph.ts';

const tz = () => timestamp({ withTimezone: true });

/** Immutable policy versions: global seeds (`organization_id` null) and workspace overrides. */
export const compliancePolicies = pgTable(
  'compliance_policies',
  {
    id: id(),
    organizationId: uuid().references(() => organization.id, { onDelete: 'cascade' }),
    jurisdiction: text().notNull(),
    channel: text().$type<OutreachChannel>().notNull(),
    version: integer().notNull(),
    kind: text().$type<'seed' | 'override'>().notNull(),
    rules: jsonb().$type<PolicyDocument>().notNull(),
    sources: jsonb().$type<{ title: string; url: string }[]>().notNull(),
    note: text(),
    needsLegalReview: boolean().notNull().default(true),
    createdBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    createdAt: tz().notNull().defaultNow(),
  },
  (table) => [
    unique('compliance_policies_version_key')
      .on(table.organizationId, table.jurisdiction, table.channel, table.kind, table.version)
      .nullsNotDistinct(),
  ],
);

/** A workspace's legal review of a seed version, and whether its owner turned on automatic sending. */
export const compliancePolicyReviews = pgTable(
  'compliance_policy_reviews',
  {
    id: id(),
    organizationId: uuid()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    policyId: uuid()
      .notNull()
      .references(() => compliancePolicies.id, { onDelete: 'cascade' }),
    reviewerName: text().notNull(),
    notes: text().notNull().default(''),
    autoSendEnabled: boolean().notNull().default(false),
    reviewedBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    reviewedAt: tz().notNull().defaultNow(),
  },
  (table) => [uniqueIndex('compliance_policy_reviews_key').on(table.organizationId, table.policyId)],
);

/** Every enqueue, send and manual-log decision, with everything it was made from (append-only). */
export const complianceDecisions = pgTable(
  'compliance_decisions',
  {
    id: id(),
    organizationId: uuid()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    contactId: uuid(),
    channel: text().$type<OutreachChannel>().notNull(),
    purpose: text().notNull(),
    stage: text().$type<ComplianceStage>().notNull(),
    decision: text().$type<ComplianceDecisionValue>().notNull(),
    jurisdictions: text().array().notNull(),
    reasons: jsonb().$type<DecisionReason[]>().notNull(),
    requiredElements: jsonb().$type<RequiredElement[]>().notNull(),
    alternatives: jsonb().$type<unknown[]>().notNull(),
    inputs: jsonb().$type<EvaluationInputs>().notNull(),
    policyVersionIds: uuid().array().notNull(),
    lawfulBasisId: uuid(),
    outboundMessageId: uuid(),
    evaluatedAt: tz().notNull().defaultNow(),
    validUntil: tz(),
  },
  (table) => [
    index('compliance_decisions_business_idx').on(table.organizationId, table.businessId, table.evaluatedAt),
    index('compliance_decisions_message_idx').on(table.outboundMessageId),
  ],
);

/** The suppression log (append-only): adds and revocations, global (`organization_id` null) or per workspace. */
export const suppressionEntries = pgTable(
  'suppression_entries',
  {
    id: id(),
    organizationId: uuid().references(() => organization.id, { onDelete: 'cascade' }),
    scope: text().$type<SuppressionScope>().notNull(),
    valueNormalized: text().notNull(),
    action: text().$type<'add' | 'revoke'>().notNull(),
    reason: text().$type<SuppressionReason>().notNull(),
    source: text().$type<SuppressionSource>().notNull(),
    actor: jsonb().$type<{ type: string; id: string | null }>().notNull(),
    note: text(),
    createdAt: tz().notNull().defaultNow(),
  },
  (table) => [
    index('suppression_entries_key_idx').on(table.organizationId, table.scope, table.valueNormalized),
  ],
);

/** The current suppressions (projection of the log, kept in the same transaction): one row per suppressed key. */
export const suppressionsCurrent = pgTable(
  'suppressions_current',
  {
    organizationId: uuid().references(() => organization.id, { onDelete: 'cascade' }),
    scope: text().$type<SuppressionScope>().notNull(),
    valueNormalized: text().notNull(),
    entryId: uuid()
      .notNull()
      .references(() => suppressionEntries.id, { onDelete: 'cascade' }),
    reason: text().$type<SuppressionReason>().notNull(),
    createdAt: tz().notNull(),
  },
  (table) => [
    unique('suppressions_current_key')
      .on(table.organizationId, table.scope, table.valueNormalized)
      .nullsNotDistinct(),
  ],
);

export const lawfulBasisRecords = pgTable('lawful_basis_records', {
  id: id(),
  organizationId: uuid()
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  kind: text().$type<'legitimate_interest_assessment' | 'consent' | 'other'>().notNull(),
  title: text().notNull(),
  purpose: text().notNull(),
  dataCategories: text().notNull(),
  necessity: text().notNull(),
  balancingTest: text().notNull(),
  safeguards: text().notNull(),
  retention: text().notNull(),
  documentMd: text().notNull().default(''),
  version: integer().notNull().default(1),
  status: text().$type<'draft' | 'approved' | 'retired'>().notNull().default('draft'),
  approvedBy: uuid().references(() => user.id, { onDelete: 'set null' }),
  approvedAt: tz(),
  ...timestamps(),
});

/** Which offers are relevant to which categories (seeded): an offer to an unrelated business is blocked. */
export const offerRelevance = pgTable(
  'offer_relevance',
  {
    id: id(),
    offer: text().notNull(),
    /** A taxonomy path prefix (`food_drink`, `beauty.salon`); empty matches every category. */
    taxonomyPrefix: text().notNull(),
    relevant: boolean().notNull(),
    rationale: jsonb().$type<{ en: string; fr: string }>().notNull(),
    position: integer().notNull(),
  },
  (table) => [uniqueIndex('offer_relevance_key').on(table.offer, table.taxonomyPrefix)],
);

/**
 * Whether a business is a legal person or a sole trader (BF-049), from a company registry (FR: recherche-entreprises),
 * cached 90 days (30 when not found). The NL/BE/GB rules depend on it.
 */
export const businessRecipientTypes = pgTable('business_recipient_types', {
  businessId: uuid()
    .primaryKey()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  recipientType: text().$type<'legal_person' | 'sole_trader' | 'public_body' | 'unknown'>().notNull(),
  legalFormCode: text(),
  registryId: text(),
  source: text().notNull(),
  fetchedAt: tz().notNull(),
});
