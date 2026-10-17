import type {
  ComplianceDecision,
  ComplianceDecisionValue,
  ComplianceStage,
  EvaluationInputs,
  OutreachChannel,
  PolicyDocument,
  SuppressionReason,
  SuppressionScope,
  SuppressionSource,
} from '@bf/contracts';

// Ports of the compliance module (BF-049).

export interface StoredPolicy {
  readonly id: string;
  readonly organizationId: string | null;
  readonly jurisdiction: string;
  readonly channel: OutreachChannel;
  readonly version: number;
  readonly kind: 'seed' | 'override';
  readonly rules: PolicyDocument;
  readonly sources: { title: string; url: string }[];
  readonly note: string | null;
  readonly needsLegalReview: boolean;
  readonly createdAt: Date;
}

export interface PolicyReview {
  readonly policyId: string;
  readonly reviewerName: string;
  readonly notes: string;
  readonly autoSendEnabled: boolean;
  readonly reviewedAt: Date;
}

export interface PolicyRepository {
  /** The latest global seed for a jurisdiction and channel. */
  seed(jurisdiction: string, channel: OutreachChannel): Promise<StoredPolicy | undefined>;
  /** The workspace's latest override, if any. */
  override(
    organizationId: string,
    jurisdiction: string,
    channel: OutreachChannel,
  ): Promise<StoredPolicy | undefined>;
  review(organizationId: string, policyId: string): Promise<PolicyReview | undefined>;
  /** Every global seed head (latest version per jurisdiction and channel). */
  seeds(): Promise<StoredPolicy[]>;
  /** The workspace's override heads. */
  overrides(organizationId: string): Promise<StoredPolicy[]>;
  reviews(organizationId: string): Promise<PolicyReview[]>;
  /** Versions of a jurisdiction and channel: the global seeds and the workspace's overrides, newest first. */
  versions(organizationId: string, jurisdiction: string, channel: OutreachChannel): Promise<StoredPolicy[]>;
  byId(organizationId: string, policyId: string): Promise<StoredPolicy | undefined>;
  /** A new override version (the next number for the workspace, jurisdiction and channel). */
  insertOverride(override: {
    organizationId: string;
    jurisdiction: string;
    channel: OutreachChannel;
    rules: PolicyDocument;
    note: string | null;
    createdBy: string | null;
  }): Promise<StoredPolicy>;
  upsertReview(review: {
    organizationId: string;
    policyId: string;
    reviewerName: string;
    notes: string;
    autoSendEnabled: boolean;
    reviewedBy: string | null;
  }): Promise<PolicyReview>;
}

export interface StoredLawfulBasis {
  readonly id: string;
  readonly organizationId: string;
  readonly kind: 'legitimate_interest_assessment' | 'consent' | 'other';
  readonly title: string;
  readonly purpose: string;
  readonly dataCategories: string;
  readonly necessity: string;
  readonly balancingTest: string;
  readonly safeguards: string;
  readonly retention: string;
  readonly documentMd: string;
  readonly version: number;
  readonly status: 'draft' | 'approved' | 'retired';
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LawfulBasisRepository {
  list(organizationId: string): Promise<StoredLawfulBasis[]>;
  get(organizationId: string, id: string): Promise<StoredLawfulBasis | undefined>;
  insert(
    record: Omit<
      StoredLawfulBasis,
      'id' | 'version' | 'status' | 'approvedBy' | 'approvedAt' | 'createdAt' | 'updatedAt'
    >,
  ): Promise<StoredLawfulBasis>;
  /** Edits a draft (an approved record is edited by making a new draft version). */
  update(
    organizationId: string,
    id: string,
    patch: Partial<StoredLawfulBasis>,
  ): Promise<StoredLawfulBasis | undefined>;
}
export const LAWFUL_BASIS_REPOSITORY = Symbol('LawfulBasisRepository');
export const POLICY_REPOSITORY = Symbol('PolicyRepository');

/** What a decision is made from, gathered from the business, its contact and the workspace. */
export interface DecisionContext {
  readonly jurisdictions: string[];
  readonly inputs: Omit<EvaluationInputs, 'jurisdictions' | 'channel'>;
  /** The keys looked up in the suppression list (normalized). */
  readonly suppressionKeys: { scope: SuppressionScope; value: string }[];
  readonly lawfulBasisId: string | null;
}

export interface ComplianceInputs {
  gather(input: {
    organizationId: string;
    businessId: string;
    contactId?: string | undefined;
    channel: OutreachChannel;
    purpose: string;
  }): Promise<DecisionContext>;
}
export const COMPLIANCE_INPUTS = Symbol('ComplianceInputs');

export interface DecisionRepository {
  insert(decision: {
    organizationId: string;
    businessId: string;
    contactId: string | null;
    channel: OutreachChannel;
    purpose: string;
    stage: Exclude<ComplianceStage, 'preview'>;
    decision: ComplianceDecisionValue;
    jurisdictions: string[];
    reasons: ComplianceDecision['reasons'];
    requiredElements: ComplianceDecision['requiredElements'];
    alternatives: ComplianceDecision['alternatives'];
    inputs: EvaluationInputs;
    policyVersionIds: string[];
    lawfulBasisId: string | null;
    validUntil: Date | null;
  }): Promise<{ id: string; evaluatedAt: Date }>;
  forBusiness(organizationId: string, businessId: string, limit: number): Promise<ComplianceDecision[]>;
}
export const DECISION_REPOSITORY = Symbol('DecisionRepository');

export interface SuppressionRepository {
  /** Appends the entry and updates the current projection (same transaction). */
  add(entry: {
    organizationId: string | null;
    scope: SuppressionScope;
    value: string;
    reason: SuppressionReason;
    source: SuppressionSource;
    actor: { type: string; id: string | null };
    note: string | null;
  }): Promise<{ id: string; created: boolean }>;
  revoke(entry: {
    organizationId: string | null;
    scope: SuppressionScope;
    value: string;
    actor: { type: string; id: string | null };
    note: string;
  }): Promise<boolean>;
  /** The current suppressions among the keys (the workspace's and global ones). */
  find(
    organizationId: string,
    keys: readonly { scope: SuppressionScope; value: string }[],
  ): Promise<{ scope: SuppressionScope; value: string; reason: SuppressionReason; entryId: string }[]>;
  entry(
    organizationId: string,
    id: string,
  ): Promise<{ scope: SuppressionScope; value: string; organizationId: string | null } | undefined>;
  list(
    organizationId: string,
    page: { limit: number; before?: Date },
  ): Promise<
    {
      id: string;
      scope: SuppressionScope;
      value: string;
      action: 'add' | 'revoke';
      reason: SuppressionReason;
      source: SuppressionSource;
      note: string | null;
      actor: { type: string; id: string | null };
      createdAt: Date;
    }[]
  >;
}
export const SUPPRESSION_REPOSITORY = Symbol('SuppressionRepository');

/** A business's recipient type from a company registry (cached), for the jurisdictions that have one. */
export interface RecipientTypeResolver {
  resolve(business: {
    id: string;
    name: string;
    postalCode: string | null;
    jurisdictions: readonly string[];
  }): Promise<'legal_person' | 'sole_trader' | 'public_body' | 'unknown'>;
}
export const RECIPIENT_TYPE_RESOLVER = Symbol('RecipientTypeResolver');

export interface ComplianceTelemetry {
  decided(event: {
    stage: string;
    channel: string;
    decision: string;
    jurisdictions: readonly string[];
    reason: string;
    seconds: number;
  }): void;
  suppressed(scope: string): void;
}
export const COMPLIANCE_TELEMETRY = Symbol('ComplianceTelemetry');
