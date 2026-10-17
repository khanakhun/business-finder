import type { EnrollmentStatus, Offer, SequenceSettings, SequenceStep } from '@bf/contracts';

// Ports of sequences (BF-053).

export interface SequenceRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly offer: Offer;
  readonly status: 'draft' | 'active' | 'archived';
  readonly headVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SequenceVersionRecord {
  readonly id: string;
  readonly sequenceId: string;
  readonly version: number;
  readonly settings: SequenceSettings;
  readonly steps: SequenceStep[];
  readonly createdAt: Date;
}

export interface EnrollmentRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly sequenceVersionId: string;
  readonly businessId: string;
  readonly contactId: string | null;
  readonly mailboxId: string | null;
  readonly threadId: string | null;
  readonly status: EnrollmentStatus;
  readonly currentStepIndex: number;
  readonly nextRunAt: Date | null;
  readonly waitingMessageId: string | null;
  readonly leaseUntil: Date | null;
  readonly variantAssignments: Record<string, string>;
  readonly autoSend: boolean;
  readonly stopReason: string | null;
  readonly pauseReason: string | null;
  readonly stoppedAt: Date | null;
  readonly enrolledBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type EnrollmentPatch = Partial<
  Pick<
    EnrollmentRecord,
    | 'mailboxId'
    | 'threadId'
    | 'currentStepIndex'
    | 'nextRunAt'
    | 'waitingMessageId'
    | 'leaseUntil'
    | 'variantAssignments'
    | 'stopReason'
    | 'pauseReason'
    | 'stoppedAt'
  >
>;

export interface EnrollmentEventRecord {
  readonly enrollmentId: string;
  readonly kind:
    | 'enrolled'
    | 'executed'
    | 'skipped'
    | 'paused'
    | 'resumed'
    | 'stopped'
    | 'rescheduled'
    | 'completed';
  readonly stepId: string | null;
  readonly variantId: string | null;
  readonly detail: string | null;
  readonly messageId: string | null;
  readonly at: Date;
}

export interface SequenceRepository {
  insert(
    sequence: Omit<SequenceRecord, 'createdAt' | 'updatedAt'>,
    version: Omit<SequenceVersionRecord, 'createdAt'>,
    createdBy: string | null,
  ): Promise<void>;
  get(organizationId: string, id: string): Promise<SequenceRecord | undefined>;
  list(organizationId: string): Promise<SequenceRecord[]>;
  update(
    organizationId: string,
    id: string,
    patch: Partial<Pick<SequenceRecord, 'name' | 'offer' | 'status' | 'headVersion'>>,
  ): Promise<void>;
  insertVersion(version: Omit<SequenceVersionRecord, 'createdAt'>, createdBy: string | null): Promise<void>;
  version(sequenceId: string, version: number): Promise<SequenceVersionRecord | undefined>;
  versionById(
    id: string,
  ): Promise<(SequenceVersionRecord & { readonly sequence: SequenceRecord }) | undefined>;
  activeEnrollmentCounts(sequenceIds: readonly string[]): Promise<Map<string, number>>;
  // Enrollments
  /** Undefined when the business already runs a sequence (one active or paused enrollment per business). */
  enroll(
    row: Omit<
      EnrollmentRecord,
      | 'createdAt'
      | 'updatedAt'
      | 'leaseUntil'
      | 'waitingMessageId'
      | 'stopReason'
      | 'pauseReason'
      | 'stoppedAt'
    >,
  ): Promise<EnrollmentRecord | undefined>;
  enrollment(organizationId: string, id: string): Promise<EnrollmentRecord | undefined>;
  enrollmentById(id: string): Promise<EnrollmentRecord | undefined>;
  enrollments(
    organizationId: string,
    filter: { businessId?: string | undefined; sequenceId?: string | undefined },
  ): Promise<EnrollmentRecord[]>;
  /** Running enrollments of a business (event subscribers). */
  running(organizationId: string, businessId: string): Promise<EnrollmentRecord[]>;
  transition(
    id: string,
    from: readonly EnrollmentStatus[],
    to: EnrollmentStatus,
    patch: EnrollmentPatch,
  ): Promise<EnrollmentRecord | undefined>;
  addEvent(event: Omit<EnrollmentEventRecord, 'at'> & { readonly at?: Date }): Promise<void>;
  events(enrollmentIds: readonly string[]): Promise<EnrollmentEventRecord[]>;
  // Execution
  /** Due active enrollments (not waiting for a message) get a lease (`FOR UPDATE SKIP LOCKED`). */
  claimDue(now: Date, leaseUntil: Date, limit: number): Promise<EnrollmentRecord[]>;
  /** Updates a running enrollment only while it holds this lease. */
  updateLeased(id: string, lease: Date, patch: EnrollmentPatch): Promise<EnrollmentRecord | undefined>;
  updateEnrollment(id: string, patch: EnrollmentPatch): Promise<EnrollmentRecord | undefined>;
  /** The enrollment whose current step waits for this message. */
  byWaitingMessage(messageId: string): Promise<EnrollmentRecord | undefined>;
  /** Facts for the stop policy and conditions. */
  hasHumanReplySince(organizationId: string, businessId: string, since: Date): Promise<boolean>;
  previewViewedSince(enrollmentId: string, since: Date): Promise<boolean>;
  businessName(businessId: string): Promise<string | null>;
  /** The kill switch (BF-056): every active enrollment of the workspace paused with this reason / resumed. */
  pauseAll(organizationId: string, reason: string): Promise<number>;
  resumeAll(organizationId: string, reason: string): Promise<number>;
  /** Mailbox reply-sync health: the last successful sync (null: never). */
  lastSyncSuccess(mailboxId: string): Promise<Date | null>;
  /** Stats rows: per enrollment step message, its variant and outcomes. */
  statsRows(sequenceId: string): Promise<
    {
      readonly stepId: string;
      readonly variantId: string;
      readonly status: string;
      readonly replied: boolean;
      readonly positive: boolean;
      readonly unsubscribed: boolean;
      readonly viewed: boolean;
    }[]
  >;
}
export const SEQUENCE_REPOSITORY = Symbol('SequenceRepository');
