import {
  type AssignOwnerRequest,
  type BulkResult,
  type ChangeStatusRequest,
  type Clock,
  type CreateNoteRequest,
  type CreateTaskRequest,
  type CrmState,
  DomainError,
  type DoNotContactRequest,
  DoNotContactSet,
  ForbiddenError,
  InvalidStateTransitionError,
  type Note,
  NoteAdded,
  NotFoundError,
  newId,
  OrgBusinessOwnerChanged,
  OrgBusinessStatusChanged,
  OrgBusinessTagsChanged,
  type PipelineStatus,
  type Task,
  TaskCompleted,
  TaskCreated,
  type UpdateNoteRequest,
  type UpdateTagsRequest,
  type UpdateTaskRequest,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { MemberDirectory } from '../../identity/index.ts';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { EventRecorder } from '../../platform/events/event-recorder.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { allowedTransitions, checkTransition, type Trigger } from '../domain/pipeline.ts';
import {
  CRM_REPOSITORY,
  type CrmRecord,
  type CrmRepository,
  type NoteRecord,
  type TaskRecord,
} from './ports.ts';

const MAX_TAGS = 30;

const workspaceOf = (auth: AuthContext): string => {
  if (!auth.orgId) throw new Error('CRM route reached without an active workspace');
  return auth.orgId;
};

export const toCrmState = (record: CrmRecord): CrmState => ({
  businessId: record.businessId as CrmState['businessId'],
  pipelineStatus: record.pipelineStatus,
  statusChangedAt: record.statusChangedAt?.toISOString() ?? null,
  allowedTransitions: allowedTransitions(record.pipelineStatus),
  disqualifiedReason: record.disqualifiedReason,
  lostReason: record.lostReason,
  ownerUserId: record.ownerUserId,
  tags: [...record.tags],
  doNotContact: record.doNotContact,
  doNotContactReason: record.doNotContactReason,
  notesCount: record.notesCount,
  openTasksCount: record.openTasksCount,
  nextTaskDueAt: record.nextTaskDueAt?.toISOString() ?? null,
});

export const toNote = (note: NoteRecord): Note => ({
  id: note.id,
  businessId: note.businessId as Note['businessId'],
  authorId: note.authorId,
  bodyMarkdown: note.bodyMarkdown,
  pinned: note.pinned,
  createdAt: note.createdAt.toISOString(),
  updatedAt: note.updatedAt.toISOString(),
});

export const toTask = (task: TaskRecord): Task => ({
  id: task.id,
  businessId: task.businessId as Task['businessId'],
  businessName: task.businessName,
  assigneeId: task.assigneeId,
  createdBy: task.createdBy,
  type: task.type,
  title: task.title,
  dueAt: task.dueAt?.toISOString() ?? null,
  status: task.status,
  completedAt: task.completedAt?.toISOString() ?? null,
  createdAt: task.createdAt.toISOString(),
});

/**
 * The workspace's relationship with a business (BF-024): pipeline moves through the state machine, owner, tags,
 * do-not-contact, notes and tasks. Every change records a domain event (the activity timeline is built from them).
 */
@Injectable()
export class CrmService {
  constructor(
    @Inject(CRM_REPOSITORY) private readonly repository: CrmRepository,
    private readonly events: EventRecorder,
    private readonly members: MemberDirectory,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async tracked(organizationId: string, businessId: string): Promise<CrmRecord> {
    const record = await this.repository.get(organizationId, businessId);
    if (!record) throw new NotFoundError('Business', businessId);
    return record;
  }

  private async member(organizationId: string, userId: string, field: string): Promise<void> {
    if (!(await this.members.isMember(organizationId, userId))) {
      throw new ValidationError('Not a member of this workspace.', [
        { path: [field], message: 'Not a member' },
      ]);
    }
  }

  async state(auth: AuthContext, businessId: string): Promise<CrmState> {
    return toCrmState(await this.tracked(workspaceOf(auth), businessId));
  }

  @Transactional()
  async changeStatus(auth: AuthContext, businessId: string, request: ChangeStatusRequest): Promise<CrmState> {
    const organizationId = workspaceOf(auth);
    await this.transition(organizationId, businessId, request.status, request.reason, 'manual');
    return this.state(auth, businessId);
  }

  /**
   * Moves a business through the pipeline. Automatic moves (outreach, site leads) come from later tickets through
   * {@link CrmPipeline}; they are no-ops when the business is not in a state they apply to.
   */
  async transition(
    organizationId: string,
    businessId: string,
    to: PipelineStatus,
    reason: string | undefined,
    trigger: Trigger,
  ): Promise<boolean> {
    const record = await this.tracked(organizationId, businessId);
    if (record.pipelineStatus === to) return false;
    const stored = checkTransition(record.pipelineStatus, to, reason, trigger);
    const moved = await this.repository.changeStatus(organizationId, businessId, {
      from: record.pipelineStatus,
      to,
      reason: stored,
      at: this.clock.now(),
    });
    // Someone else moved it first: the move was decided on a stale status.
    if (!moved) throw new InvalidStateTransitionError('Pipeline status', record.pipelineStatus, to);
    await this.events.record(OrgBusinessStatusChanged, {
      orgId: organizationId,
      payload: {
        businessId: businessId as never,
        from: record.pipelineStatus,
        to,
        reason: stored,
        automatic: trigger === 'automatic',
      },
    });
    return true;
  }

  @Transactional()
  async assignOwner(auth: AuthContext, businessId: string, request: AssignOwnerRequest): Promise<CrmState> {
    const organizationId = workspaceOf(auth);
    const record = await this.tracked(organizationId, businessId);
    if (request.ownerUserId) await this.member(organizationId, request.ownerUserId, 'ownerUserId');
    if (record.ownerUserId !== request.ownerUserId) {
      await this.repository.setOwner(organizationId, businessId, request.ownerUserId);
      await this.events.record(OrgBusinessOwnerChanged, {
        payload: { businessId: businessId as never, ownerUserId: request.ownerUserId },
      });
    }
    return this.state(auth, businessId);
  }

  @Transactional()
  async updateTags(auth: AuthContext, businessId: string, request: UpdateTagsRequest): Promise<CrmState> {
    await this.applyTags(workspaceOf(auth), businessId, request.add, request.remove);
    return this.state(auth, businessId);
  }

  private async applyTags(
    organizationId: string,
    businessId: string,
    add: readonly string[],
    remove: readonly string[],
  ): Promise<boolean> {
    const record = await this.tracked(organizationId, businessId);
    const removing = new Set(remove.map((t) => t.toLowerCase()));
    const kept = record.tags.filter((t) => !removing.has(t.toLowerCase()));
    const present = new Set(kept.map((t) => t.toLowerCase()));
    const added: string[] = [];
    for (const tag of add.map((t) => t.trim())) {
      if (present.has(tag.toLowerCase())) continue;
      present.add(tag.toLowerCase());
      added.push(tag);
    }
    const next = [...kept, ...added];
    if (next.length > MAX_TAGS) {
      throw new ValidationError(`A business keeps at most ${MAX_TAGS} tags.`, [
        { path: ['add'], message: 'Too many' },
      ]);
    }
    const removed = record.tags.filter((t) => removing.has(t.toLowerCase()));
    if (added.length === 0 && removed.length === 0) return false;
    await this.repository.setTags(organizationId, businessId, next);
    await this.events.record(OrgBusinessTagsChanged, {
      orgId: organizationId,
      payload: { businessId: businessId as never, added, removed },
    });
    return true;
  }

  @Transactional()
  async setDoNotContact(
    auth: AuthContext,
    businessId: string,
    request: DoNotContactRequest,
  ): Promise<CrmState> {
    const organizationId = workspaceOf(auth);
    const record = await this.tracked(organizationId, businessId);
    const reason = request.doNotContact ? (request.reason?.trim() ?? null) : null;
    if (record.doNotContact !== request.doNotContact || record.doNotContactReason !== reason) {
      await this.repository.setDoNotContact(organizationId, businessId, request.doNotContact, reason);
      await this.events.record(DoNotContactSet, {
        payload: { businessId: businessId as never, doNotContact: request.doNotContact, reason },
      });
    }
    return this.state(auth, businessId);
  }

  /** One change per business, each in its own transaction: a refused move never undoes the others. */
  async bulkStatus(
    auth: AuthContext,
    businessIds: readonly string[],
    to: PipelineStatus,
    reason: string | undefined,
  ): Promise<BulkResult> {
    const organizationId = workspaceOf(auth);
    return this.bulk(businessIds, (id) =>
      this.bulkOne(() => this.transition(organizationId, id, to, reason, 'manual')),
    );
  }

  async bulkTags(
    auth: AuthContext,
    businessIds: readonly string[],
    add: readonly string[],
    remove: readonly string[],
  ): Promise<BulkResult> {
    const organizationId = workspaceOf(auth);
    return this.bulk(businessIds, (id) =>
      this.bulkOne(() => this.applyTags(organizationId, id, add, remove)),
    );
  }

  @Transactional()
  private async bulkOne(change: () => Promise<boolean>): Promise<boolean> {
    return change();
  }

  private async bulk(ids: readonly string[], apply: (id: string) => Promise<boolean>): Promise<BulkResult> {
    let changed = 0;
    let unchanged = 0;
    const failed: BulkResult['failed'] = [];
    for (const id of new Set(ids)) {
      try {
        if (await apply(id)) changed++;
        else unchanged++;
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        failed.push({ businessId: id, code: error.code });
      }
    }
    return { changed, unchanged, failed };
  }

  // --- Notes ----------------------------------------------------------------------------------------------------

  async notes(auth: AuthContext, businessId: string): Promise<Note[]> {
    const organizationId = workspaceOf(auth);
    await this.tracked(organizationId, businessId);
    return (await this.repository.listNotes(organizationId, businessId)).map(toNote);
  }

  @Transactional()
  async addNote(auth: AuthContext, businessId: string, request: CreateNoteRequest): Promise<Note> {
    const organizationId = workspaceOf(auth);
    await this.tracked(organizationId, businessId);
    const now = this.clock.now();
    const note: NoteRecord = {
      id: newId(),
      businessId,
      authorId: auth.userId,
      bodyMarkdown: request.bodyMarkdown,
      pinned: request.pinned,
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.insertNote({ ...note, organizationId });
    await this.repository.refreshCounters(organizationId, businessId);
    await this.events.record(NoteAdded, { payload: { businessId: businessId as never, noteId: note.id } });
    return toNote(note);
  }

  private async ownNote(auth: AuthContext, noteId: string): Promise<NoteRecord> {
    const note = await this.repository.getNote(workspaceOf(auth), noteId);
    if (!note) throw new NotFoundError('Note', noteId);
    if (note.authorId !== auth.userId) throw new ForbiddenError('Only the author can change a note.');
    return note;
  }

  @Transactional()
  async updateNote(auth: AuthContext, noteId: string, request: UpdateNoteRequest): Promise<Note> {
    await this.ownNote(auth, noteId);
    await this.repository.updateNote(workspaceOf(auth), noteId, request);
    return toNote((await this.repository.getNote(workspaceOf(auth), noteId)) as NoteRecord);
  }

  @Transactional()
  async deleteNote(auth: AuthContext, noteId: string): Promise<void> {
    const note = await this.ownNote(auth, noteId);
    await this.repository.deleteNote(workspaceOf(auth), noteId, this.clock.now());
    await this.repository.refreshCounters(workspaceOf(auth), note.businessId);
  }

  // --- Tasks ----------------------------------------------------------------------------------------------------

  @Transactional()
  async addTask(auth: AuthContext, businessId: string, request: CreateTaskRequest): Promise<Task> {
    const organizationId = workspaceOf(auth);
    await this.tracked(organizationId, businessId);
    const assigneeId = request.assigneeId ?? auth.userId;
    if (assigneeId) await this.member(organizationId, assigneeId, 'assigneeId');
    const id = newId();
    await this.repository.insertTask({
      id,
      organizationId,
      businessId,
      assigneeId,
      createdBy: auth.userId,
      type: request.type,
      title: request.title,
      dueAt: request.dueAt ? new Date(request.dueAt) : null,
      status: 'open',
      createdAt: this.clock.now(),
    });
    await this.repository.refreshCounters(organizationId, businessId);
    const task = (await this.repository.getTask(organizationId, id)) as TaskRecord;
    await this.events.record(TaskCreated, {
      payload: {
        businessId: businessId as never,
        taskId: id,
        title: task.title,
        dueAt: task.dueAt?.toISOString() ?? null,
      },
    });
    return toTask(task);
  }

  @Transactional()
  async updateTask(auth: AuthContext, taskId: string, request: UpdateTaskRequest): Promise<Task> {
    const organizationId = workspaceOf(auth);
    const task = await this.repository.getTask(organizationId, taskId);
    if (!task) throw new NotFoundError('Task', taskId);
    if (request.assigneeId) await this.member(organizationId, request.assigneeId, 'assigneeId');
    const completing = request.status === 'done' && task.status !== 'done';
    await this.repository.updateTask(organizationId, taskId, {
      ...(request.type !== undefined ? { type: request.type } : {}),
      ...(request.title !== undefined ? { title: request.title } : {}),
      ...(request.dueAt !== undefined ? { dueAt: request.dueAt ? new Date(request.dueAt) : null } : {}),
      ...(request.assigneeId !== undefined ? { assigneeId: request.assigneeId } : {}),
      ...(request.status !== undefined
        ? { status: request.status, completedAt: request.status === 'done' ? this.clock.now() : null }
        : {}),
    });
    await this.repository.refreshCounters(organizationId, task.businessId);
    if (completing) {
      await this.events.record(TaskCompleted, {
        payload: { businessId: task.businessId as never, taskId, title: request.title ?? task.title },
      });
    }
    return toTask((await this.repository.getTask(organizationId, taskId)) as TaskRecord);
  }
}

/** Automatic pipeline moves for later tickets (outreach sends, site leads): no-ops when they do not apply. */
@Injectable()
export class CrmPipeline {
  constructor(private readonly crm: CrmService) {}

  @Transactional()
  async markContacted(organizationId: string, businessId: string): Promise<boolean> {
    return this.safely(() =>
      this.crm.transition(organizationId, businessId, 'contacted', undefined, 'automatic'),
    );
  }

  @Transactional()
  async markEngaged(organizationId: string, businessId: string): Promise<boolean> {
    return this.safely(() =>
      this.crm.transition(organizationId, businessId, 'engaged', undefined, 'automatic'),
    );
  }

  private async safely(move: () => Promise<boolean>): Promise<boolean> {
    try {
      return await move();
    } catch (error) {
      // Not (or no longer) tracked by the workspace, or not in a state the move applies to.
      if (error instanceof InvalidStateTransitionError || error instanceof NotFoundError) return false;
      throw error;
    }
  }
}
