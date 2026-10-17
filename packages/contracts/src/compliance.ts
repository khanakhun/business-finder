import { z } from 'zod';
import { defineEvent } from './events.ts';
import { BusinessId } from './ids.ts';
import { OfferSchema } from './taxonomy.ts';

// Outreach compliance (BF-049, ADR-0012): a typed rule DSL per jurisdiction and channel, decisions on a lattice
// (`allowed < allowed_with_conditions < manual_only < blocked`, the most restrictive wins), the suppression log and
// lawful-basis records. Not legal advice: seeded policies need a recorded legal review before automatic sending.

export const COMPLIANCE_DECISIONS = ['allowed', 'allowed_with_conditions', 'manual_only', 'blocked'] as const;
export const ComplianceDecisionValueSchema = z.enum(COMPLIANCE_DECISIONS);
export type ComplianceDecisionValue = z.infer<typeof ComplianceDecisionValueSchema>;

export const OUTREACH_CHANNELS = ['email', 'phone', 'whatsapp', 'sms', 'letter'] as const;
export const OutreachChannelSchema = z.enum(OUTREACH_CHANNELS);
export type OutreachChannel = z.infer<typeof OutreachChannelSchema>;

/** ISO 3166-1 alpha-2 (incl. BL, MF), or `*` for any other. */
export const JurisdictionSchema = z.string().regex(/^([A-Z]{2}|\*)$/);
export type Jurisdiction = z.infer<typeof JurisdictionSchema>;

export const RECIPIENT_TYPES = ['legal_person', 'sole_trader', 'public_body', 'unknown'] as const;
export const ADDRESS_TYPES = ['generic', 'department', 'personal', 'unknown'] as const;
export const PUBLISHED_CONTEXTS = ['own_contact_page', 'own_site_other', 'directory', 'unknown'] as const;
export const RELEVANCES = ['relevant', 'not_relevant', 'unknown'] as const;
export const PREVIOUS_CONTACTS = ['none', 'replied', 'bounced'] as const;
export const TRI_STATES = ['yes', 'no', 'unknown'] as const;

const Localized = z.object({ en: z.string().min(1).max(600), fr: z.string().min(1).max(600) });
export type LocalizedReason = z.infer<typeof Localized>;

/** What a rule matches: each key present must match (a list means "any of"); absent keys match anything. */
export const PolicyConditionSchema = z
  .object({
    recipientType: z.array(z.enum(RECIPIENT_TYPES)).min(1).optional(),
    addressType: z.array(z.enum(ADDRESS_TYPES)).min(1).optional(),
    publishedContext: z.array(z.enum(PUBLISHED_CONTEXTS)).min(1).optional(),
    designatedForSolicitation: z.array(z.enum(TRI_STATES)).min(1).optional(),
    relevance: z.array(z.enum(RELEVANCES)).min(1).optional(),
    previousContact: z.array(z.enum(PREVIOUS_CONTACTS)).min(1).optional(),
  })
  .strict();
export type PolicyCondition = z.infer<typeof PolicyConditionSchema>;

export const PolicyRuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9_.-]{1,60}$/),
  when: PolicyConditionSchema,
  decision: ComplianceDecisionValueSchema,
  explain: Localized,
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const REQUIRED_ELEMENTS = [
  'sender_identity',
  'postal_address',
  'opt_out_link',
  'unsubscribe_headers',
  'source_disclosure',
  'relevance',
  'recipient_language',
  'honest_subject',
  'identify_on_call',
  'stop_on_request',
] as const;
export const RequiredElementSchema = z.enum(REQUIRED_ELEMENTS);
export type RequiredElement = z.infer<typeof RequiredElementSchema>;

/** A policy: the first matching rule decides; otherwise the default. */
export const PolicyDocumentSchema = z.object({
  default: ComplianceDecisionValueSchema,
  defaultExplain: Localized,
  rules: z.array(PolicyRuleSchema).max(40),
  requiredElements: z.array(RequiredElementSchema).max(REQUIRED_ELEMENTS.length),
});
export type PolicyDocument = z.infer<typeof PolicyDocumentSchema>;

export const PolicySourceSchema = z.object({ title: z.string().min(1).max(200), url: z.url() });

/** A seeded policy file (`seeds/policies/<jurisdiction>.<channel>.json`). */
export const PolicySeedSchema = z.object({
  jurisdiction: JurisdictionSchema,
  channel: OutreachChannelSchema,
  policy: PolicyDocumentSchema,
  sources: z.array(PolicySourceSchema).max(10),
  note: z.string().max(600).optional(),
});
export type PolicySeed = z.infer<typeof PolicySeedSchema>;

/** Everything a decision is made from (resolved before the pure evaluation; persisted with it). */
export const EvaluationInputsSchema = z.object({
  jurisdictions: z.array(JurisdictionSchema).min(1),
  channel: OutreachChannelSchema,
  recipientType: z.enum(RECIPIENT_TYPES),
  addressType: z.enum(ADDRESS_TYPES),
  publishedContext: z.enum(PUBLISHED_CONTEXTS),
  designatedForSolicitation: z.enum(TRI_STATES),
  relevance: z.enum(RELEVANCES),
  previousContact: z.enum(PREVIOUS_CONTACTS),
  // Overlays (applied after the jurisdiction rule; the most restrictive wins).
  suppressed: z.boolean(),
  doNotContact: z.boolean(),
  noSolicitationMarker: z.boolean(),
  addressInvalid: z.boolean(),
  workspaceReady: z.boolean(),
  lawfulBasisApproved: z.boolean(),
});
export type EvaluationInputs = z.infer<typeof EvaluationInputsSchema>;

export const DecisionReasonSchema = z.object({
  code: z.string().max(60),
  message: Localized,
  ruleRef: z.string().max(120).nullable(),
});
export type DecisionReason = z.infer<typeof DecisionReasonSchema>;

export const ALTERNATIVES = ['manual_call', 'manual_email', 'letter', 'manual_whatsapp'] as const;

export const COMPLIANCE_STAGES = ['preview', 'enqueue', 'send', 'manual_log'] as const;
export const ComplianceStageSchema = z.enum(COMPLIANCE_STAGES);
export type ComplianceStage = z.infer<typeof ComplianceStageSchema>;

export const ComplianceDecisionSchema = z
  .object({
    /** Null for a preview (not persisted). */
    id: z.uuid().nullable(),
    decision: ComplianceDecisionValueSchema,
    channel: OutreachChannelSchema,
    stage: ComplianceStageSchema,
    jurisdictions: z.array(JurisdictionSchema),
    reasons: z.array(DecisionReasonSchema),
    requiredElements: z.array(RequiredElementSchema),
    alternatives: z.array(z.object({ code: z.enum(ALTERNATIVES), label: Localized })),
    policyVersionIds: z.array(z.uuid()),
    /** Automatic sending is permitted for this jurisdiction and channel (reviewed policy, enabled by an owner). */
    autoSendPermitted: z.boolean(),
    inputs: EvaluationInputsSchema,
    evaluatedAt: z.iso.datetime(),
    validUntil: z.iso.datetime().nullable(),
  })
  .meta({ id: 'ComplianceDecision' });
export type ComplianceDecision = z.infer<typeof ComplianceDecisionSchema>;

export const EvaluateComplianceRequestSchema = z
  .object({
    businessId: BusinessId,
    contactId: z.uuid().optional(),
    channel: OutreachChannelSchema,
    purpose: OfferSchema,
  })
  .meta({ id: 'EvaluateComplianceRequest' });
export type EvaluateComplianceRequest = z.infer<typeof EvaluateComplianceRequestSchema>;

export const ComplianceDecisionPageSchema = z
  .object({ items: z.array(ComplianceDecisionSchema) })
  .meta({ id: 'ComplianceDecisionList' });

// ── Policies (effective, versions, review, overrides) ────────────────────────────────────────────────────────────

export const PolicyVersionSchema = z
  .object({
    id: z.uuid(),
    jurisdiction: JurisdictionSchema,
    channel: OutreachChannelSchema,
    version: z.number().int().positive(),
    kind: z.enum(['seed', 'override']),
    policy: PolicyDocumentSchema,
    sources: z.array(PolicySourceSchema),
    needsLegalReview: z.boolean(),
    reviewedBy: z.string().nullable(),
    reviewedAt: z.iso.datetime().nullable(),
    reviewNotes: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'CompliancePolicyVersion' });
export type PolicyVersion = z.infer<typeof PolicyVersionSchema>;

export const EffectivePolicySchema = z
  .object({
    jurisdiction: JurisdictionSchema,
    channel: OutreachChannelSchema,
    seed: PolicyVersionSchema,
    override: PolicyVersionSchema.nullable(),
    /** The seed was reviewed for this workspace, and its owner turned on automatic sending. */
    autoSendEnabled: z.boolean(),
  })
  .meta({ id: 'EffectiveCompliancePolicy' });
export type EffectivePolicy = z.infer<typeof EffectivePolicySchema>;

export const EffectivePolicyListSchema = z
  .object({ items: z.array(EffectivePolicySchema) })
  .meta({ id: 'EffectiveCompliancePolicyList' });

export const ReviewPolicyRequestSchema = z
  .object({
    reviewerName: z.string().trim().min(2).max(120),
    notes: z.string().trim().max(2000).default(''),
    confirmed: z.literal(true),
    /** Also allow automatic sending for this jurisdiction and channel (owners with `outreach:auto_send`). */
    enableAutoSend: z.boolean().default(false),
  })
  .meta({ id: 'ReviewCompliancePolicyRequest' });
export type ReviewPolicyRequest = z.input<typeof ReviewPolicyRequestSchema>;

export const CreatePolicyOverrideRequestSchema = z
  .object({
    jurisdiction: JurisdictionSchema,
    channel: OutreachChannelSchema,
    policy: PolicyDocumentSchema,
    note: z.string().trim().max(600).optional(),
  })
  .meta({ id: 'CreateCompliancePolicyOverrideRequest' });
export type CreatePolicyOverrideRequest = z.infer<typeof CreatePolicyOverrideRequestSchema>;

// ── Suppression ──────────────────────────────────────────────────────────────────────────────────────────────────

export const SUPPRESSION_SCOPES = ['email', 'domain', 'phone', 'business', 'org_business'] as const;
export const SuppressionScopeSchema = z.enum(SUPPRESSION_SCOPES);
export type SuppressionScope = z.infer<typeof SuppressionScopeSchema>;

export const SUPPRESSION_REASONS = [
  'unsubscribe',
  'opt_out',
  'complaint',
  'hard_bounce',
  'manual',
  'dsr_objection',
  'no_solicitation',
  'legal',
] as const;
export const SuppressionReasonSchema = z.enum(SUPPRESSION_REASONS);
export type SuppressionReason = z.infer<typeof SuppressionReasonSchema>;

export const SUPPRESSION_SOURCES = [
  'link',
  'one_click',
  'reply',
  'site_form',
  'api',
  'import',
  'admin',
  'system',
] as const;
export const SuppressionSourceSchema = z.enum(SUPPRESSION_SOURCES);
export type SuppressionSource = z.infer<typeof SuppressionSourceSchema>;

export const SuppressionEntrySchema = z
  .object({
    id: z.uuid(),
    scope: SuppressionScopeSchema,
    value: z.string(),
    action: z.enum(['add', 'revoke']),
    reason: SuppressionReasonSchema,
    source: SuppressionSourceSchema,
    note: z.string().nullable(),
    actor: z.object({ type: z.string(), id: z.string().nullable() }),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'SuppressionEntry' });
export type SuppressionEntry = z.infer<typeof SuppressionEntrySchema>;

export const SuppressionPageSchema = z
  .object({ items: z.array(SuppressionEntrySchema), nextCursor: z.string().nullable() })
  .meta({ id: 'SuppressionPage' });

export const CreateSuppressionRequestSchema = z
  .object({
    scope: SuppressionScopeSchema,
    value: z.string().trim().min(1).max(320),
    reason: SuppressionReasonSchema.default('manual'),
    note: z.string().trim().max(500).optional(),
  })
  .meta({ id: 'CreateSuppressionRequest' });
export type CreateSuppressionRequest = z.input<typeof CreateSuppressionRequestSchema>;

export const CheckSuppressionRequestSchema = z
  .object({
    keys: z
      .array(z.object({ scope: SuppressionScopeSchema, value: z.string().trim().min(1).max(320) }))
      .min(1)
      .max(100),
  })
  .meta({ id: 'CheckSuppressionRequest' });

export const CheckSuppressionResponseSchema = z
  .object({
    suppressed: z.array(
      z.object({ scope: SuppressionScopeSchema, value: z.string(), reason: SuppressionReasonSchema }),
    ),
  })
  .meta({ id: 'CheckSuppressionResponse' });

export const RevokeSuppressionRequestSchema = z
  .object({ note: z.string().trim().min(3).max(500) })
  .meta({ id: 'RevokeSuppressionRequest' });

/** A suppression was added (DOMAIN §4): outreach stops, sequences end. */
export const ContactSuppressed = defineEvent(
  'contact.suppressed',
  1,
  z.object({
    entryId: z.uuid(),
    scope: SuppressionScopeSchema,
    /** For `org_business`/`business` scopes: the business; else null (the value is not repeated in events). */
    businessId: BusinessId.nullable(),
    reason: SuppressionReasonSchema,
  }),
);

// ── Lawful basis ─────────────────────────────────────────────────────────────────────────────────────────────────

export const LAWFUL_BASIS_STATUSES = ['draft', 'approved', 'retired'] as const;

export const LawfulBasisRecordSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['legitimate_interest_assessment', 'consent', 'other']),
    title: z.string(),
    purpose: z.string(),
    dataCategories: z.string(),
    necessity: z.string(),
    balancingTest: z.string(),
    safeguards: z.string(),
    retention: z.string(),
    documentMd: z.string(),
    version: z.number().int().positive(),
    status: z.enum(LAWFUL_BASIS_STATUSES),
    approvedBy: z.string().nullable(),
    approvedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'LawfulBasisRecord' });
export type LawfulBasisRecord = z.infer<typeof LawfulBasisRecordSchema>;

export const LawfulBasisListSchema = z
  .object({ items: z.array(LawfulBasisRecordSchema) })
  .meta({ id: 'LawfulBasisList' });

const lbText = (max: number) => z.string().trim().max(max);
export const UpsertLawfulBasisRequestSchema = z
  .object({
    kind: z
      .enum(['legitimate_interest_assessment', 'consent', 'other'])
      .default('legitimate_interest_assessment'),
    title: lbText(200).min(3),
    purpose: lbText(2000),
    dataCategories: lbText(2000),
    necessity: lbText(4000),
    balancingTest: lbText(6000),
    safeguards: lbText(4000),
    retention: lbText(1000),
    documentMd: lbText(20000).default(''),
  })
  .meta({ id: 'UpsertLawfulBasisRequest' });
export type UpsertLawfulBasisRequest = z.input<typeof UpsertLawfulBasisRequestSchema>;
