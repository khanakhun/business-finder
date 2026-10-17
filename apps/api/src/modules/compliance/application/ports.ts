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
}
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
