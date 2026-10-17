import type {
  ComplianceDecision,
  ComplianceDecisionValue,
  ComplianceStage,
  DsrStatus,
  DsrType,
  EvaluationInputs,
  OutreachChannel,
  PolicyDocument,
  RetentionRun,
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
  byIds(organizationId: string, ids: readonly string[]): Promise<ComplianceDecision[]>;
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
  /** The log filtered (BF-055): newest first. */
  searchLog(organizationId: string, filter: SuppressionFilter): Promise<SuppressionLogRow[]>;
  /** What is suppressed now (the workspace's and global entries), newest first. */
  searchCurrent(organizationId: string, filter: SuppressionFilter): Promise<CurrentSuppressionRow[]>;
}
export const SUPPRESSION_REPOSITORY = Symbol('SuppressionRepository');

export interface SuppressionFilter {
  readonly q?: string | undefined;
  readonly scope?: SuppressionScope | undefined;
  readonly reason?: SuppressionReason | undefined;
  readonly source?: SuppressionSource | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly before?: Date | undefined;
  readonly limit: number;
}

export interface SuppressionLogRow {
  readonly id: string;
  readonly scope: SuppressionScope;
  readonly value: string;
  readonly action: 'add' | 'revoke';
  readonly reason: SuppressionReason;
  readonly source: SuppressionSource;
  readonly note: string | null;
  readonly actor: { type: string; id: string | null };
  readonly createdAt: Date;
}

export interface CurrentSuppressionRow {
  readonly entryId: string;
  readonly scope: SuppressionScope;
  readonly value: string;
  readonly reason: SuppressionReason;
  readonly source: SuppressionSource;
  readonly note: string | null;
  readonly global: boolean;
  readonly createdAt: Date;
}

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

// ── Unsubscribe tokens (BF-055) ─────────────────────────────────────────────────────────────────────────────────

export interface UnsubscribeTokenRow {
  readonly id: string;
  readonly organizationId: string;
  readonly contactId: string | null;
  readonly emailSealed: string;
  readonly emailHash: string;
  readonly businessId: string | null;
  readonly outboundMessageId: string | null;
  readonly locale: 'en' | 'fr';
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

export interface UnsubscribeTokenRepository {
  insert(
    row: Omit<UnsubscribeTokenRow, 'id' | 'createdAt' | 'usedAt'> & { readonly tokenHash: string },
  ): Promise<string>;
  findByHash(tokenHash: string): Promise<UnsubscribeTokenRow | undefined>;
  markUsed(id: string, at: Date): Promise<void>;
  /** Expired tokens, in batches (retention). */
  deleteExpired(before: Date, limit: number): Promise<number>;
}
export const UNSUBSCRIBE_TOKEN_REPOSITORY = Symbol('UnsubscribeTokenRepository');

export interface UnsubscribeSettings {
  /** Origin of the links, e.g. https://u.example.com (no trailing slash). */
  readonly baseUrl: string;
  /** Pepper of the privacy hashes (stable for the deployment's life). */
  readonly pepper: string;
}
export const UNSUBSCRIBE_SETTINGS = Symbol('UnsubscribeSettings');

// ── Data-subject requests and retention (BF-055) ────────────────────────────────────────────────────────────────

export interface StoredDsrRequest {
  readonly id: string;
  readonly organizationId: string;
  readonly type: DsrType;
  readonly status: DsrStatus;
  readonly source: 'admin' | 'public';
  readonly subjectSealed: string | null;
  readonly subjectHash: string | null;
  readonly receivedAt: Date;
  readonly dueAt: Date;
  readonly verification: { method: string; notes: string; at: string; by: string | null } | null;
  readonly actions: { at: string; kind: string; by: string | null; detail: Record<string, unknown> }[];
  readonly exportKey: string | null;
  readonly handledBy: string | null;
  readonly remindedAt: string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DsrRepository {
  insert(row: Omit<StoredDsrRequest, 'id' | 'createdAt' | 'updatedAt'>): Promise<StoredDsrRequest>;
  list(organizationId: string): Promise<StoredDsrRequest[]>;
  get(organizationId: string, id: string): Promise<StoredDsrRequest | undefined>;
  update(
    organizationId: string,
    id: string,
    patch: Partial<Omit<StoredDsrRequest, 'id' | 'organizationId' | 'createdAt' | 'updatedAt'>>,
  ): Promise<StoredDsrRequest>;
  /** Open requests of every workspace due before `before` (reminders). */
  openDueBefore(before: Date): Promise<StoredDsrRequest[]>;
  /** Completed requests whose export is older than `before` (retention of exports). */
  exportsBefore(before: Date, limit: number): Promise<StoredDsrRequest[]>;
}
export const DSR_REPOSITORY = Symbol('DsrRepository');

export interface RetentionRunRepository {
  start(dryRun: boolean, triggeredBy: string | null): Promise<string>;
  finish(id: string, results: RetentionRun['results']): Promise<RetentionRun>;
  recent(limit: number): Promise<RetentionRun[]>;
  /** Starts today's real run for the one process that may (none in the last 20 hours); null otherwise. */
  claimDailyRun(): Promise<string | null>;
}
export const RETENTION_RUNS = Symbol('RetentionRunRepository');
