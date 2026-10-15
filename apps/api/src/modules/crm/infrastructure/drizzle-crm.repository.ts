import type { Activity, PipelineStatus } from '@bf/contracts';
import { PIPELINE_STATUSES } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { activities, businesses, categories, notes, orgBusinesses, tasks } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type {
  BoardCard,
  CrmRecord,
  CrmRepository,
  NoteRecord,
  StatusChange,
  TaskRecord,
} from '../application/ports.ts';

const atText = (column: SQL | typeof activities.occurredAt) =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const uuidArray = (values: readonly string[]) =>
  sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::uuid[]`;

const crmColumns = {
  businessId: orgBusinesses.businessId,
  displayName: businesses.displayName,
  pipelineStatus: orgBusinesses.pipelineStatus,
  statusChangedAt: orgBusinesses.statusChangedAt,
  disqualifiedReason: orgBusinesses.disqualifiedReason,
  lostReason: orgBusinesses.lostReason,
  ownerUserId: orgBusinesses.ownerUserId,
  tags: orgBusinesses.tags,
  doNotContact: orgBusinesses.doNotContact,
  doNotContactReason: orgBusinesses.doNotContactReason,
  notesCount: orgBusinesses.notesCount,
  openTasksCount: orgBusinesses.openTasksCount,
  nextTaskDueAt: orgBusinesses.nextTaskDueAt,
};

const scope = (organizationId: string, businessId: string) =>
  and(eq(orgBusinesses.organizationId, organizationId), eq(orgBusinesses.businessId, businessId));

@Injectable()
export class DrizzleCrmRepository implements CrmRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private get x() {
    return getExecutor(this.db);
  }

  async get(organizationId: string, businessId: string): Promise<CrmRecord | undefined> {
    const [row] = await this.getMany(organizationId, [businessId]);
    return row;
  }

  async getMany(organizationId: string, businessIds: readonly string[]): Promise<CrmRecord[]> {
    if (businessIds.length === 0) return [];
    return this.x
      .select(crmColumns)
      .from(orgBusinesses)
      .innerJoin(businesses, eq(businesses.id, orgBusinesses.businessId))
      .where(
        and(
          eq(orgBusinesses.organizationId, organizationId),
          sql`${orgBusinesses.businessId} = ANY(${uuidArray(businessIds)})`,
        ),
      );
  }

  async changeStatus(organizationId: string, businessId: string, change: StatusChange): Promise<boolean> {
    const updated = await this.x
      .update(orgBusinesses)
      .set({
        pipelineStatus: change.to,
        statusChangedAt: change.at,
        // A reason belongs to the status it explains; reopening clears it.
        lostReason: change.to === 'lost' ? change.reason : null,
        disqualifiedReason: change.to === 'disqualified' ? change.reason : null,
      })
      .where(and(scope(organizationId, businessId), eq(orgBusinesses.pipelineStatus, change.from)))
      .returning({ id: orgBusinesses.businessId });
    return updated.length > 0;
  }

  async setOwner(organizationId: string, businessId: string, ownerUserId: string | null): Promise<void> {
    await this.x.update(orgBusinesses).set({ ownerUserId }).where(scope(organizationId, businessId));
  }

  async setTags(organizationId: string, businessId: string, tags: readonly string[]): Promise<void> {
    await this.x
      .update(orgBusinesses)
      .set({ tags: [...tags] })
      .where(scope(organizationId, businessId));
  }

  async setDoNotContact(organizationId: string, businessId: string, value: boolean, reason: string | null) {
    await this.x
      .update(orgBusinesses)
      .set({ doNotContact: value, doNotContactReason: value ? reason : null })
      .where(scope(organizationId, businessId));
  }

  async listNotes(organizationId: string, businessId: string): Promise<NoteRecord[]> {
    return this.x
      .select({
        id: notes.id,
        businessId: notes.businessId,
        authorId: notes.authorId,
        bodyMarkdown: notes.bodyMarkdown,
        pinned: notes.pinned,
        createdAt: notes.createdAt,
        updatedAt: notes.updatedAt,
      })
      .from(notes)
      .where(
        and(
          eq(notes.organizationId, organizationId),
          eq(notes.businessId, businessId),
          isNull(notes.deletedAt),
        ),
      )
      .orderBy(desc(notes.pinned), desc(notes.createdAt), desc(notes.id))
      .limit(500);
  }

  async getNote(organizationId: string, noteId: string): Promise<NoteRecord | undefined> {
    const [row] = await this.x
      .select({
        id: notes.id,
        businessId: notes.businessId,
        authorId: notes.authorId,
        bodyMarkdown: notes.bodyMarkdown,
        pinned: notes.pinned,
        createdAt: notes.createdAt,
        updatedAt: notes.updatedAt,
      })
      .from(notes)
      .where(and(eq(notes.organizationId, organizationId), eq(notes.id, noteId), isNull(notes.deletedAt)));
    return row;
  }

  async insertNote(note: NoteRecord & { readonly organizationId: string }): Promise<void> {
    await this.x.insert(notes).values(note);
  }

  async updateNote(
    organizationId: string,
    noteId: string,
    patch: { bodyMarkdown?: string | undefined; pinned?: boolean | undefined },
  ): Promise<void> {
    await this.x
      .update(notes)
      .set(patch)
      .where(and(eq(notes.organizationId, organizationId), eq(notes.id, noteId)));
  }

  async deleteNote(organizationId: string, noteId: string, at: Date): Promise<void> {
    await this.x
      .update(notes)
      .set({ deletedAt: at })
      .where(and(eq(notes.organizationId, organizationId), eq(notes.id, noteId)));
  }

  private taskColumns() {
    return {
      id: tasks.id,
      businessId: tasks.businessId,
      businessName: businesses.displayName,
      assigneeId: tasks.assigneeId,
      createdBy: tasks.createdBy,
      type: tasks.type,
      title: tasks.title,
      dueAt: tasks.dueAt,
      status: tasks.status,
      completedAt: tasks.completedAt,
      createdAt: tasks.createdAt,
    };
  }

  async getTask(organizationId: string, taskId: string): Promise<TaskRecord | undefined> {
    const [row] = await this.x
      .select(this.taskColumns())
      .from(tasks)
      .innerJoin(businesses, eq(businesses.id, tasks.businessId))
      .where(and(eq(tasks.organizationId, organizationId), eq(tasks.id, taskId)));
    return row;
  }

  async insertTask(
    task: Omit<TaskRecord, 'businessName' | 'completedAt'> & { readonly organizationId: string },
  ) {
    await this.x.insert(tasks).values(task);
  }

  async updateTask(
    organizationId: string,
    taskId: string,
    patch: Partial<Pick<TaskRecord, 'type' | 'title' | 'dueAt' | 'assigneeId' | 'status' | 'completedAt'>>,
  ): Promise<void> {
    await this.x
      .update(tasks)
      .set(patch)
      .where(and(eq(tasks.organizationId, organizationId), eq(tasks.id, taskId)));
  }

  async listTasks(
    organizationId: string,
    filter: {
      readonly assigneeId: string | null;
      readonly due: 'today' | 'overdue' | 'upcoming' | 'all';
      readonly status: 'open' | 'done' | 'cancelled';
      readonly now: Date;
      readonly businessId?: string;
    },
    page: { readonly limit: number; readonly after?: { readonly key: string; readonly id: string } },
  ) {
    const now = filter.now.toISOString();
    const startOfTomorrow = sql`date_trunc('day', ${now}::timestamptz) + interval '1 day'`;
    const due: Record<typeof filter.due, SQL | undefined> = {
      all: undefined,
      overdue: sql`${tasks.dueAt} < ${now}::timestamptz`,
      today: sql`${tasks.dueAt} >= ${now}::timestamptz AND ${tasks.dueAt} < ${startOfTomorrow}`,
      upcoming: sql`(${tasks.dueAt} >= ${startOfTomorrow} OR ${tasks.dueAt} IS NULL)`,
    };
    // Due date first (no due date last), then creation: the sort key as text keeps the cursor exact.
    const key = sql<string>`coalesce(to_char(${tasks.dueAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '9999') || '|' || to_char(${tasks.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const rows = await this.x
      .select({ ...this.taskColumns(), key })
      .from(tasks)
      .innerJoin(businesses, eq(businesses.id, tasks.businessId))
      .where(
        and(
          eq(tasks.organizationId, organizationId),
          eq(tasks.status, filter.status),
          filter.assigneeId ? eq(tasks.assigneeId, filter.assigneeId) : undefined,
          filter.businessId ? eq(tasks.businessId, filter.businessId) : undefined,
          due[filter.due],
          page.after ? sql`(${key}, ${tasks.id}) > (${page.after.key}, ${page.after.id}::uuid)` : undefined,
        ),
      )
      .orderBy(key, tasks.id)
      .limit(page.limit);
    return rows.map(({ key: k, ...task }) => ({ ...task, position: { key: k, id: task.id } }));
  }

  async refreshCounters(organizationId: string, businessId: string): Promise<void> {
    await this.x.execute(sql`
      UPDATE ${orgBusinesses} SET
        notes_count = (SELECT count(*)::int FROM ${notes} n
          WHERE n.organization_id = ${organizationId} AND n.business_id = ${businessId} AND n.deleted_at IS NULL),
        open_tasks_count = (SELECT count(*)::int FROM ${tasks} t
          WHERE t.organization_id = ${organizationId} AND t.business_id = ${businessId} AND t.status = 'open'),
        next_task_due_at = (SELECT min(t.due_at) FROM ${tasks} t
          WHERE t.organization_id = ${organizationId} AND t.business_id = ${businessId} AND t.status = 'open')
      WHERE organization_id = ${organizationId} AND business_id = ${businessId}`);
  }

  async insertActivity(
    activity: Omit<Activity, 'id' | 'occurredAt'> & {
      readonly id: string;
      readonly organizationId: string;
      readonly occurredAt: Date;
      readonly sourceEventId: string | null;
    },
  ): Promise<boolean> {
    const inserted = await this.x
      .insert(activities)
      .values({
        id: activity.id,
        organizationId: activity.organizationId,
        businessId: activity.businessId,
        type: activity.type,
        actor: activity.actor,
        data: activity.data,
        occurredAt: activity.occurredAt,
        sourceEventId: activity.sourceEventId,
      })
      .onConflictDoNothing()
      .returning({ id: activities.id });
    return inserted.length > 0;
  }

  async listActivities(
    organizationId: string,
    businessId: string,
    page: { readonly limit: number; readonly after?: { readonly occurredAt: string; readonly id: string } },
  ) {
    const rows = await this.x
      .select({
        id: activities.id,
        businessId: activities.businessId,
        type: activities.type,
        actor: activities.actor,
        data: activities.data,
        occurredAt: activities.occurredAt,
        at: atText(activities.occurredAt),
      })
      .from(activities)
      .where(
        and(
          eq(activities.organizationId, organizationId),
          eq(activities.businessId, businessId),
          page.after
            ? sql`(${activities.occurredAt}, ${activities.id}) < (${page.after.occurredAt}::timestamptz, ${page.after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(activities.occurredAt), desc(activities.id))
      .limit(page.limit);
    return rows.map(({ at, occurredAt, ...row }) => ({
      ...row,
      businessId: row.businessId as Activity['businessId'],
      actor: row.actor as Activity['actor'],
      occurredAt: occurredAt.toISOString(),
      position: { occurredAt: at, id: row.id },
    }));
  }

  async workspacesTracking(businessId: string): Promise<string[]> {
    const rows = await this.x
      .select({ id: orgBusinesses.organizationId })
      .from(orgBusinesses)
      .where(eq(orgBusinesses.businessId, businessId));
    return rows.map((r) => r.id);
  }

  async repointMerged(fromId: string, toId: string): Promise<void> {
    for (const table of [notes, tasks, activities]) {
      await this.x.update(table).set({ businessId: toId }).where(eq(table.businessId, fromId));
    }
  }

  async board(
    organizationId: string,
    filter: {
      readonly ownerUserId?: string;
      readonly tag?: string;
      readonly categoryId?: string;
      readonly tier?: string;
      readonly limit: number;
    },
  ) {
    const where = and(
      eq(orgBusinesses.organizationId, organizationId),
      sql`${businesses.mergedIntoId} IS NULL`,
      filter.ownerUserId ? eq(orgBusinesses.ownerUserId, filter.ownerUserId) : undefined,
      filter.tag ? sql`${orgBusinesses.tags} @> ARRAY[${filter.tag}]::text[]` : undefined,
      filter.tier ? eq(orgBusinesses.tier, filter.tier as 'A') : undefined,
      filter.categoryId
        ? sql`EXISTS (SELECT 1 FROM business_categories bc JOIN ${categories} c ON c.id = bc.category_id
            WHERE bc.business_id = ${businesses.id}
              AND c.path <@ (SELECT sel.path FROM ${categories} sel WHERE sel.id = ${filter.categoryId}))`
        : undefined,
    );
    const counts = await this.x
      .select({ status: orgBusinesses.pipelineStatus, n: sql<number>`count(*)::int` })
      .from(orgBusinesses)
      .innerJoin(businesses, eq(businesses.id, orgBusinesses.businessId))
      .where(where)
      .groupBy(orgBusinesses.pipelineStatus);
    const byStatus = new Map(counts.map((c) => [c.status, c.n]));
    // Each column: most recently moved first (the cards someone is working on).
    const ranked = this.x
      .select({
        ...crmColumns,
        primaryCategoryId: businesses.primaryCategoryId,
        locality: businesses.locality,
        score: orgBusinesses.score,
        tier: orgBusinesses.tier,
        rank: sql<number>`row_number() OVER (PARTITION BY ${orgBusinesses.pipelineStatus} ORDER BY coalesce(${orgBusinesses.statusChangedAt}, ${orgBusinesses.createdAt}) DESC, ${orgBusinesses.businessId})`.as(
          'rank',
        ),
      })
      .from(orgBusinesses)
      .innerJoin(businesses, eq(businesses.id, orgBusinesses.businessId))
      .where(where)
      .as('ranked');
    const cards = await this.x.select().from(ranked).where(sql`${ranked.rank} <= ${filter.limit}`);
    return PIPELINE_STATUSES.map((status: PipelineStatus) => ({
      status,
      count: byStatus.get(status) ?? 0,
      cards: cards
        .filter((c) => c.pipelineStatus === status && c.rank <= filter.limit)
        .sort((a, b) => a.rank - b.rank)
        .map(({ rank: _rank, ...card }): BoardCard => card),
    }));
  }
}
