import type { Activity, PipelineStatus, ScoreTier, TaskQuery } from '@bf/contracts';

export interface CrmRecord {
  readonly businessId: string;
  readonly displayName: string;
  readonly pipelineStatus: PipelineStatus;
  readonly statusChangedAt: Date | null;
  readonly disqualifiedReason: string | null;
  readonly lostReason: string | null;
  readonly ownerUserId: string | null;
  readonly tags: readonly string[];
  readonly doNotContact: boolean;
  readonly doNotContactReason: string | null;
  readonly notesCount: number;
  readonly openTasksCount: number;
  readonly nextTaskDueAt: Date | null;
}

export interface StatusChange {
  readonly from: PipelineStatus;
  readonly to: PipelineStatus;
  readonly reason: string | null;
  readonly at: Date;
}

export interface NoteRecord {
  readonly id: string;
  readonly businessId: string;
  readonly authorId: string | null;
  readonly bodyMarkdown: string;
  readonly pinned: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TaskRecord {
  readonly id: string;
  readonly businessId: string;
  readonly businessName: string;
  readonly assigneeId: string | null;
  readonly createdBy: string | null;
  readonly type: 'call' | 'email' | 'visit' | 'follow_up' | 'other';
  readonly title: string;
  readonly dueAt: Date | null;
  readonly status: 'open' | 'done' | 'cancelled';
  readonly completedAt: Date | null;
  readonly createdAt: Date;
}

export interface BoardCard
  extends Omit<
    CrmRecord,
    | 'notesCount'
    | 'openTasksCount'
    | 'tags'
    | 'doNotContact'
    | 'doNotContactReason'
    | 'disqualifiedReason'
    | 'lostReason'
  > {
  readonly primaryCategoryId: string | null;
  readonly locality: string | null;
  readonly score: number | null;
  readonly tier: string | null;
}

export interface CrmRepository {
  /** Locks the workspace's row of a business until the transaction ends (serialises counters and tags). */
  lock(organizationId: string, businessId: string): Promise<void>;
  /** The workspace's state for a business it tracks. */
  get(organizationId: string, businessId: string): Promise<CrmRecord | undefined>;
  getMany(organizationId: string, businessIds: readonly string[]): Promise<CrmRecord[]>;
  /** Moves the status only if it is still `change.from` (concurrent moves lose); false when it was not. */
  changeStatus(organizationId: string, businessId: string, change: StatusChange): Promise<boolean>;
  setOwner(organizationId: string, businessId: string, ownerUserId: string | null): Promise<void>;
  setTags(organizationId: string, businessId: string, tags: readonly string[]): Promise<void>;
  setDoNotContact(
    organizationId: string,
    businessId: string,
    value: boolean,
    reason: string | null,
  ): Promise<void>;

  listNotes(organizationId: string, businessId: string): Promise<NoteRecord[]>;
  getNote(organizationId: string, noteId: string): Promise<NoteRecord | undefined>;
  insertNote(note: NoteRecord & { readonly organizationId: string }): Promise<void>;
  updateNote(
    organizationId: string,
    noteId: string,
    patch: { bodyMarkdown?: string | undefined; pinned?: boolean | undefined },
  ): Promise<void>;
  deleteNote(organizationId: string, noteId: string, at: Date): Promise<void>;

  getTask(organizationId: string, taskId: string): Promise<TaskRecord | undefined>;
  insertTask(
    task: Omit<TaskRecord, 'businessName' | 'completedAt'> & { readonly organizationId: string },
  ): Promise<void>;
  updateTask(
    organizationId: string,
    taskId: string,
    patch: Partial<Pick<TaskRecord, 'type' | 'title' | 'dueAt' | 'assigneeId' | 'status' | 'completedAt'>>,
  ): Promise<void>;
  listTasks(
    organizationId: string,
    filter: {
      readonly assigneeId: string | null;
      readonly due: TaskQuery['due'];
      readonly status: TaskQuery['status'];
      readonly now: Date;
      readonly timeZone: string;
      readonly businessId?: string;
    },
    page: { readonly limit: number; readonly after?: { readonly key: string; readonly id: string } },
  ): Promise<Array<TaskRecord & { readonly position: { readonly key: string; readonly id: string } }>>;

  /** Recomputes notes/tasks counters and the next due task of a business. */
  refreshCounters(organizationId: string, businessId: string): Promise<void>;

  /** Idempotent on (source event, workspace). */
  insertActivity(
    activity: Omit<Activity, 'id' | 'occurredAt'> & {
      readonly id: string;
      readonly organizationId: string;
      readonly occurredAt: Date;
      readonly sourceEventId: string | null;
    },
  ): Promise<boolean>;
  listActivities(
    organizationId: string,
    businessId: string,
    page: { readonly limit: number; readonly after?: { readonly occurredAt: string; readonly id: string } },
  ): Promise<Array<Activity & { readonly position: { readonly occurredAt: string; readonly id: string } }>>;
  /** Workspaces that track a business (fan-out of global events). */
  workspacesTracking(businessId: string): Promise<string[]>;
  /** Merge: notes, tasks and activities of `fromId` move to `toId` (in every workspace). */
  repointMerged(fromId: string, toId: string): Promise<void>;

  board(
    organizationId: string,
    filter: {
      readonly ownerUserId?: string;
      readonly tag?: string;
      readonly categoryId?: string;
      readonly tier?: ScoreTier;
      readonly limit: number;
    },
  ): Promise<Array<{ readonly status: PipelineStatus; readonly count: number; readonly cards: BoardCard[] }>>;
}
export const CRM_REPOSITORY = Symbol('CrmRepository');
