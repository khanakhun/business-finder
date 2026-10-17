import { type DbClient, getExecutor } from '@bf/db';
import { enrollmentEvents, sequenceEnrollments, sequences, sequenceVersions } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
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
}
