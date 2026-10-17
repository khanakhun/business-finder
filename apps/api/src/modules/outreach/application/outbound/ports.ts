import type {
  EmailLocale,
  EmailPurpose,
  ManualContactChannel,
  Offer,
  OutboundError,
  OutboundStatus,
} from '@bf/contracts';

// Ports of the outbound pipeline (BF-052): the message rows (the lifecycle's source of truth), their threads, and
// manual contact logs.

export interface StatusEntry {
  readonly at: string;
  readonly status: OutboundStatus;
  readonly detail: string | null;
}

export interface OutboundRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly businessId: string;
  readonly contactId: string | null;
  readonly threadId: string;
  readonly mailboxId: string | null;
  readonly draftId: string | null;
  readonly sequenceEnrollmentId: string | null;
  readonly sequenceStep: number | null;
  readonly bulkRunId: string | null;
  readonly purpose: EmailPurpose;
  readonly offer: Offer;
  readonly locale: EmailLocale;
  readonly toEmail: string | null;
  readonly subject: string;
  readonly bodyText: string;
  readonly bodyHtml: string;
  readonly headers: Record<string, string>;
  readonly unsubscribeTokenId: string | null;
  readonly outreachToken: string | null;
  readonly enqueueDecisionId: string | null;
  readonly sendDecisionId: string | null;
  readonly lawfulBasisId: string | null;
  readonly footerVersion: number;
  readonly blockedReasons: string[];
  readonly status: OutboundStatus;
  readonly scheduledAt: Date;
  readonly leaseUntil: Date | null;
  readonly sentAt: Date | null;
  readonly providerMessageId: string | null;
  readonly rfc822MessageId: string;
  readonly providerThreadId: string | null;
  readonly inReplyTo: string | null;
  readonly attempts: number;
  readonly lastAttemptAt: Date | null;
  readonly lastError: OutboundError | null;
  readonly statusHistory: StatusEntry[];
  readonly idempotencyKey: string;
  readonly createdBy: string | null;
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type NewOutbound = Omit<
  OutboundRecord,
  | 'createdAt'
  | 'updatedAt'
  | 'attempts'
  | 'lastAttemptAt'
  | 'lastError'
  | 'leaseUntil'
  | 'sentAt'
  | 'providerMessageId'
>;

export type OutboundPatch = Partial<
  Pick<
    OutboundRecord,
    | 'mailboxId'
    | 'scheduledAt'
    | 'leaseUntil'
    | 'sentAt'
    | 'providerMessageId'
    | 'rfc822MessageId'
    | 'providerThreadId'
    | 'sendDecisionId'
    | 'blockedReasons'
    | 'attempts'
    | 'lastAttemptAt'
    | 'lastError'
    | 'subject'
    | 'bodyText'
    | 'bodyHtml'
    | 'headers'
    | 'approvedBy'
    | 'approvedAt'
  >
>;

export interface ThreadRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly businessId: string;
  readonly contactId: string | null;
  readonly mailboxId: string | null;
  readonly subjectRoot: string;
  readonly rootMessageId: string;
  readonly providerThreadId: string | null;
  readonly status: 'open' | 'replied' | 'closed';
  readonly lastMessageAt: Date;
}

export interface OutboundListFilter {
  readonly statuses?: readonly OutboundStatus[] | undefined;
  readonly mailboxId?: string | undefined;
  readonly businessId?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  /** Keyset: strictly before this (createdAt, id). */
  readonly before?: { readonly createdAt: Date; readonly id: string } | undefined;
  readonly limit: number;
}

export interface OutboundListRow extends OutboundRecord {
  readonly businessName: string;
  readonly mailboxEmail: string | null;
}

export interface ManualLogRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly businessId: string;
  readonly contactId: string | null;
  readonly channel: ManualContactChannel;
  readonly decisionId: string;
  readonly summary: string;
  readonly outcome: string | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

export interface OutboundRepository {
  byIdempotencyKey(organizationId: string, key: string): Promise<OutboundRecord | undefined>;
  get(organizationId: string, id: string): Promise<OutboundRecord | undefined>;
  insert(row: NewOutbound): Promise<OutboundRecord>;
  /**
   * Compare-and-set on the status: moves the message only when it is still in one of `from`; appends the history
   * entry. Undefined when it was not (another worker or a person moved it first).
   */
  transition(
    organizationId: string,
    id: string,
    from: readonly OutboundStatus[],
    to: OutboundStatus,
    patch: OutboundPatch,
    entry: StatusEntry,
    /** Also require this lease (the send worker). */
    lease?: Date,
  ): Promise<OutboundRecord | undefined>;
  list(organizationId: string, filter: OutboundListFilter): Promise<OutboundListRow[]>;
  listRow(organizationId: string, id: string): Promise<OutboundListRow | undefined>;
  forBusiness(organizationId: string, businessId: string, limit: number): Promise<OutboundListRow[]>;
  // The send path (worker: no workspace filter, ids come from claimed rows)
  byId(id: string): Promise<OutboundRecord | undefined>;
  /**
   * Due `queued` messages move to `sending` with a lease (`FOR UPDATE SKIP LOCKED`: concurrent ticks never claim
   * the same row).
   */
  claimDue(now: Date, leaseUntil: Date, limit: number): Promise<OutboundRecord[]>;
  /** `sending` messages whose lease ran out (a worker died, a send hung) get a new lease to be reconciled. */
  releaseExpired(now: Date, leaseUntil: Date, limit: number): Promise<OutboundRecord[]>;
  /** Failed messages due for an automatic retry go back to `queued`. */
  requeueRetries(now: Date, maxAttempts: number, limit: number): Promise<number>;
  /** Updates a message only while it is still `sending` under this lease. */
  updateLeased(id: string, lease: Date, patch: OutboundPatch): Promise<OutboundRecord | undefined>;
  /** Messages still `sending` though their lease ended before `before` (the stuck-send alert). */
  countStuck(before: Date): Promise<number>;
  // Threads
  insertThread(row: Omit<ThreadRecord, 'lastMessageAt' | 'status'>): Promise<ThreadRecord>;
  /** The latest open thread with the business (and contact), for a follow-up. */
  openThread(
    organizationId: string,
    businessId: string,
    contactId: string | null,
  ): Promise<ThreadRecord | undefined>;
  /** The thread's latest sent message (In-Reply-To / References of a follow-up). */
  lastSent(threadId: string): Promise<OutboundRecord | undefined>;
  touchThread(threadId: string, at: Date, providerThreadId: string | null): Promise<void>;
  // Manual contact logs
  insertManualLog(row: Omit<ManualLogRecord, 'createdAt'>): Promise<ManualLogRecord>;
  manualLogs(organizationId: string, businessId: string, limit: number): Promise<ManualLogRecord[]>;
}
export const OUTBOUND_REPOSITORY = Symbol('OutboundRepository');

/** Signs the short token appended to preview links (`?r=`): which message a visit came from. */
export interface OutreachTokens {
  sign(messageId: string): string;
}
export const OUTREACH_TOKENS = Symbol('OutreachTokens');

export interface OutboundSettings {
  /** The undo window: a message is queued for at least this long before it may be sent. */
  readonly undoWindowSeconds: number;
}
export const OUTBOUND_SETTINGS = Symbol('OutboundSettings');
