import { type DbClient, getExecutor } from '@bf/db';
import {
  businesses,
  emailThreads,
  enrollmentEvents,
  inboundMessages,
  mailboxSyncState,
  outboundMessages,
  outboundMessageViews,
  sequenceEnrollments,
  sequences,
  sequenceVersions,
} from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';
import type {
  EnrollmentEventRecord,
  EnrollmentRecord,
  SequenceRecord,
  SequenceRepository,
  SequenceVersionRecord,
} from '../../application/sequences/ports.ts';

const UNIQUE_VIOLATION = '23505';

const isUniqueViolation = (error: unknown) => {
  const cause = (error as { cause?: { code?: string } })?.cause;
  return (error as { code?: string })?.code === UNIQUE_VIOLATION || cause?.code === UNIQUE_VIOLATION;
};

@Injectable()
export class DrizzleSequencesRepository implements SequenceRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private get x() {
    return getExecutor(this.db);
  }

  async insert(
    sequence: Parameters<SequenceRepository['insert']>[0],
    version: Parameters<SequenceRepository['insert']>[1],
    createdBy: string | null,
  ) {
    await this.x.insert(sequences).values(sequence);
    await this.x.insert(sequenceVersions).values({ ...version, createdBy });
  }

  async get(organizationId: string, id: string) {
    const [row] = await this.x
      .select()
      .from(sequences)
      .where(and(eq(sequences.organizationId, organizationId), eq(sequences.id, id)));
    return row as SequenceRecord | undefined;
  }

  async list(organizationId: string) {
    return (await this.x
      .select()
      .from(sequences)
      .where(eq(sequences.organizationId, organizationId))
      .orderBy(desc(sequences.updatedAt))) as SequenceRecord[];
  }

  async update(organizationId: string, id: string, patch: Parameters<SequenceRepository['update']>[2]) {
    await this.x
      .update(sequences)
      .set(patch)
      .where(and(eq(sequences.organizationId, organizationId), eq(sequences.id, id)));
  }

  async insertVersion(version: Parameters<SequenceRepository['insertVersion']>[0], createdBy: string | null) {
    await this.x.insert(sequenceVersions).values({ ...version, createdBy });
  }

  async version(sequenceId: string, version: number) {
    const [row] = await this.x
      .select()
      .from(sequenceVersions)
      .where(and(eq(sequenceVersions.sequenceId, sequenceId), eq(sequenceVersions.version, version)));
    return row as SequenceVersionRecord | undefined;
  }

  async versionById(id: string) {
    const [row] = await this.x
      .select({ version: sequenceVersions, sequence: sequences })
      .from(sequenceVersions)
      .innerJoin(sequences, eq(sequences.id, sequenceVersions.sequenceId))
      .where(eq(sequenceVersions.id, id));
    return row
      ? { ...(row.version as SequenceVersionRecord), sequence: row.sequence as SequenceRecord }
      : undefined;
  }

  async activeEnrollmentCounts(sequenceIds: readonly string[]) {
    if (sequenceIds.length === 0) return new Map<string, number>();
    const rows = await this.x
      .select({ sequenceId: sequenceVersions.sequenceId, n: count() })
      .from(sequenceEnrollments)
      .innerJoin(sequenceVersions, eq(sequenceVersions.id, sequenceEnrollments.sequenceVersionId))
      .where(
        and(
          inArray(sequenceVersions.sequenceId, [...sequenceIds]),
          inArray(sequenceEnrollments.status, ['active', 'paused']),
        ),
      )
      .groupBy(sequenceVersions.sequenceId);
    return new Map(rows.map((row) => [row.sequenceId, Number(row.n)]));
  }

  async enroll(row: Parameters<SequenceRepository['enroll']>[0]) {
    try {
      const [stored] = await this.x.insert(sequenceEnrollments).values(row).returning();
      return stored as EnrollmentRecord | undefined;
    } catch (error) {
      // One active or paused enrollment per business and workspace (partial unique index).
      if (isUniqueViolation(error)) return undefined;
      throw error;
    }
  }

  async enrollment(organizationId: string, id: string) {
    const [row] = await this.x
      .select()
      .from(sequenceEnrollments)
      .where(and(eq(sequenceEnrollments.organizationId, organizationId), eq(sequenceEnrollments.id, id)));
    return row as EnrollmentRecord | undefined;
  }

  async enrollmentById(id: string) {
    const [row] = await this.x.select().from(sequenceEnrollments).where(eq(sequenceEnrollments.id, id));
    return row as EnrollmentRecord | undefined;
  }

  async enrollments(organizationId: string, filter: Parameters<SequenceRepository['enrollments']>[1]) {
    const base = this.x
      .select({ enrollment: sequenceEnrollments })
      .from(sequenceEnrollments)
      .innerJoin(sequenceVersions, eq(sequenceVersions.id, sequenceEnrollments.sequenceVersionId))
      .where(
        and(
          eq(sequenceEnrollments.organizationId, organizationId),
          filter.businessId ? eq(sequenceEnrollments.businessId, filter.businessId) : undefined,
          filter.sequenceId ? eq(sequenceVersions.sequenceId, filter.sequenceId) : undefined,
        ),
      )
      .orderBy(desc(sequenceEnrollments.createdAt))
      .limit(200);
    return (await base).map((row) => row.enrollment as EnrollmentRecord);
  }

  async running(organizationId: string, businessId: string) {
    return (await this.x
      .select()
      .from(sequenceEnrollments)
      .where(
        and(
          eq(sequenceEnrollments.organizationId, organizationId),
          eq(sequenceEnrollments.businessId, businessId),
          inArray(sequenceEnrollments.status, ['active', 'paused']),
        ),
      )) as EnrollmentRecord[];
  }

  async transition(
    id: string,
    from: Parameters<SequenceRepository['transition']>[1],
    to: Parameters<SequenceRepository['transition']>[2],
    patch: Parameters<SequenceRepository['transition']>[3],
  ) {
    const [row] = await this.x
      .update(sequenceEnrollments)
      .set({ ...patch, status: to })
      .where(and(eq(sequenceEnrollments.id, id), inArray(sequenceEnrollments.status, [...from])))
      .returning();
    return row as EnrollmentRecord | undefined;
  }

  async addEvent(event: Parameters<SequenceRepository['addEvent']>[0]) {
    await this.x.insert(enrollmentEvents).values(event);
  }

  async events(enrollmentIds: readonly string[]) {
    if (enrollmentIds.length === 0) return [];
    return (await this.x
      .select()
      .from(enrollmentEvents)
      .where(inArray(enrollmentEvents.enrollmentId, [...enrollmentIds]))
      .orderBy(enrollmentEvents.at)) as EnrollmentEventRecord[];
  }

  async claimDue(now: Date, leaseUntil: Date, limit: number) {
    const due = this.x
      .select({ id: sequenceEnrollments.id })
      .from(sequenceEnrollments)
      .where(
        and(
          eq(sequenceEnrollments.status, 'active'),
          lte(sequenceEnrollments.nextRunAt, now),
          isNull(sequenceEnrollments.waitingMessageId),
          or(isNull(sequenceEnrollments.leaseUntil), lt(sequenceEnrollments.leaseUntil, now)),
        ),
      )
      .orderBy(sequenceEnrollments.nextRunAt)
      .limit(limit)
      .for('update', { skipLocked: true });
    return (await this.x
      .update(sequenceEnrollments)
      .set({ leaseUntil })
      .where(inArray(sequenceEnrollments.id, due))
      .returning()) as EnrollmentRecord[];
  }

  async updateLeased(id: string, lease: Date, patch: Parameters<SequenceRepository['updateLeased']>[2]) {
    const [row] = await this.x
      .update(sequenceEnrollments)
      .set(patch)
      .where(
        and(
          eq(sequenceEnrollments.id, id),
          eq(sequenceEnrollments.leaseUntil, lease),
          inArray(sequenceEnrollments.status, ['active', 'paused']),
        ),
      )
      .returning();
    return row as EnrollmentRecord | undefined;
  }

  async updateEnrollment(id: string, patch: Parameters<SequenceRepository['updateEnrollment']>[1]) {
    const [row] = await this.x
      .update(sequenceEnrollments)
      .set(patch)
      .where(eq(sequenceEnrollments.id, id))
      .returning();
    return row as EnrollmentRecord | undefined;
  }

  async byWaitingMessage(messageId: string) {
    const [row] = await this.x
      .select()
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.waitingMessageId, messageId))
      .limit(1);
    return row as EnrollmentRecord | undefined;
  }

  async hasHumanReplySince(organizationId: string, businessId: string, since: Date) {
    const [row] = await this.x
      .select({ id: inboundMessages.id })
      .from(inboundMessages)
      .innerJoin(emailThreads, eq(emailThreads.id, inboundMessages.threadId))
      .where(
        and(
          eq(inboundMessages.organizationId, organizationId),
          eq(emailThreads.businessId, businessId),
          eq(inboundMessages.kind, 'human'),
          gte(inboundMessages.receivedAt, since),
        ),
      )
      .limit(1);
    return !!row;
  }

  async previewViewedSince(enrollmentId: string, since: Date) {
    const [row] = await this.x
      .select({ id: outboundMessageViews.outboundMessageId })
      .from(outboundMessageViews)
      .innerJoin(outboundMessages, eq(outboundMessages.id, outboundMessageViews.outboundMessageId))
      .where(
        and(
          eq(outboundMessages.sequenceEnrollmentId, enrollmentId),
          gte(outboundMessageViews.lastViewedAt, since),
        ),
      )
      .limit(1);
    return !!row;
  }

  async businessName(businessId: string) {
    const [row] = await this.x
      .select({ name: businesses.displayName })
      .from(businesses)
      .where(eq(businesses.id, businessId));
    return row?.name ?? null;
  }

  async lastSyncSuccess(mailboxId: string) {
    const [row] = await this.x
      .select({ at: mailboxSyncState.lastSuccessAt })
      .from(mailboxSyncState)
      .where(eq(mailboxSyncState.mailboxId, mailboxId));
    return row?.at ?? null;
  }

  async statsRows(sequenceId: string) {
    const replies = this.x
      .select({
        outboundMessageId: inboundMessages.outboundMessageId,
        triageClass: sql<
          string | null
        >`coalesce(${inboundMessages.correctedClass}, ${inboundMessages.triage} ->> 'class')`.as(
          'triage_class',
        ),
        unsubscribe: inboundMessages.unsubscribeDetected,
      })
      .from(inboundMessages)
      .where(eq(inboundMessages.kind, 'human'))
      .as('replies');
    const rows = await this.x
      .select({
        stepId: enrollmentEvents.stepId,
        variantId: enrollmentEvents.variantId,
        status: outboundMessages.status,
        triageClass: replies.triageClass,
        unsubscribe: replies.unsubscribe,
        views: outboundMessageViews.views,
      })
      .from(enrollmentEvents)
      .innerJoin(sequenceEnrollments, eq(sequenceEnrollments.id, enrollmentEvents.enrollmentId))
      .innerJoin(sequenceVersions, eq(sequenceVersions.id, sequenceEnrollments.sequenceVersionId))
      .innerJoin(outboundMessages, eq(outboundMessages.id, enrollmentEvents.messageId))
      .leftJoin(replies, eq(replies.outboundMessageId, outboundMessages.id))
      .leftJoin(outboundMessageViews, eq(outboundMessageViews.outboundMessageId, outboundMessages.id))
      .where(and(eq(sequenceVersions.sequenceId, sequenceId), eq(enrollmentEvents.kind, 'executed')));
    return rows.map((row) => ({
      stepId: row.stepId ?? '',
      variantId: row.variantId ?? 'default',
      status: row.status,
      replied: row.triageClass !== null || row.unsubscribe === true,
      positive: row.triageClass === 'interested' || row.triageClass === 'question',
      unsubscribed: row.unsubscribe === true || row.triageClass === 'unsubscribe',
      viewed: (row.views ?? 0) > 0,
    }));
  }
}
