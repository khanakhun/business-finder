import {
  type Activity,
  BusinessCreated,
  BusinessMerged,
  type DomainEvent,
  DoNotContactSet,
  encodeCursor,
  ForbiddenError,
  fixedClock,
  InvalidStateTransitionError,
  NotFoundError,
  OrgBusinessStatusChanged,
  type Permission,
  TaskCompleted,
  TaskQuerySchema,
  ValidationError,
} from '@bf/contracts';
import type { DbClient } from '@bf/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MemberDirectory } from '../../identity/index.ts';
import { setTransactionalDb } from '../../platform/db/transactional.ts';
import type { EventRecorder } from '../../platform/events/event-recorder.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import type { RealtimePublisher } from '../../realtime/index.ts';
import { ActivitySubscriber } from './activity.subscriber.ts';
import { CrmQueries } from './crm.queries.ts';
import { CrmPipeline, CrmService } from './crm.service.ts';
import type { CrmRecord, CrmRepository, NoteRecord, TaskRecord } from './ports.ts';

// The CRM use cases over an in-memory repository (SQL, HTTP and the worker are covered by crm.int.test.ts).

const fakeDb = { transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({}) } as unknown as DbClient;
beforeAll(() => setTransactionalDb(fakeDb));
afterAll(() => setTransactionalDb(undefined));

const ORG = '0192a1b2-0000-7000-8000-0000000000aa';
const USER = '0192a1b2-0000-7000-8000-0000000000bb';
const OTHER = '0192a1b2-0000-7000-8000-0000000000cc';
const id = (n: number) => `0192a1b2-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-10-14T12:00:00Z');

const auth = (userId: string | null = USER): AuthContext =>
  ({
    orgId: ORG,
    userId,
    permissions: new Set<Permission>(['business:read', 'business:write']),
  }) as unknown as AuthContext;

const record = (n: number, overrides: Partial<CrmRecord> = {}): CrmRecord => ({
  businessId: id(n),
  displayName: `Business ${n}`,
  pipelineStatus: 'new',
  statusChangedAt: null,
  disqualifiedReason: null,
  lostReason: null,
  ownerUserId: null,
  tags: [],
  doNotContact: false,
  doNotContactReason: null,
  notesCount: 0,
  openTasksCount: 0,
  nextTaskDueAt: null,
  ...overrides,
});

class FakeRepository implements CrmRepository {
  readonly records = new Map<string, CrmRecord>();
  readonly notes = new Map<string, NoteRecord>();
  readonly tasks = new Map<string, TaskRecord>();
  readonly activities: Array<{ type: string; organizationId: string; sourceEventId: string | null }> = [];
  readonly repointed: Array<[string, string]> = [];
  lose = false;
  lock = vi.fn(async () => {});

  async get(organizationId: string, businessId: string) {
    return organizationId === ORG ? this.records.get(businessId) : undefined;
  }
  async getMany(organizationId: string, businessIds: readonly string[]) {
    return (await Promise.all(businessIds.map((b) => this.get(organizationId, b)))).filter(
      (r): r is CrmRecord => r !== undefined,
    );
  }
  private patch(businessId: string, patch: Partial<CrmRecord>) {
    this.records.set(businessId, { ...(this.records.get(businessId) as CrmRecord), ...patch });
  }
  async changeStatus(_o: string, businessId: string, change: { to: CrmRecord['pipelineStatus']; at: Date }) {
    if (this.lose) return false;
    this.patch(businessId, { pipelineStatus: change.to, statusChangedAt: change.at });
    return true;
  }
  async setOwner(_o: string, businessId: string, ownerUserId: string | null) {
    this.patch(businessId, { ownerUserId });
  }
  async setTags(_o: string, businessId: string, tags: readonly string[]) {
    this.patch(businessId, { tags });
  }
  async setDoNotContact(
    _o: string,
    businessId: string,
    doNotContact: boolean,
    doNotContactReason: string | null,
  ) {
    this.patch(businessId, { doNotContact, doNotContactReason });
  }
  async listNotes(_o: string, businessId: string) {
    return [...this.notes.values()].filter((n) => n.businessId === businessId);
  }
  async getNote(_o: string, noteId: string) {
    return this.notes.get(noteId);
  }
  async insertNote(note: NoteRecord) {
    this.notes.set(note.id, note);
  }
  async updateNote(_o: string, noteId: string, patch: { bodyMarkdown?: string; pinned?: boolean }) {
    this.notes.set(noteId, { ...(this.notes.get(noteId) as NoteRecord), ...patch });
  }
  async deleteNote(_o: string, noteId: string) {
    this.notes.delete(noteId);
  }
  async getTask(_o: string, taskId: string) {
    return this.tasks.get(taskId);
  }
  async insertTask(task: Omit<TaskRecord, 'businessName' | 'completedAt'>) {
    this.tasks.set(task.id, { ...task, businessName: 'Business', completedAt: null });
  }
  async updateTask(_o: string, taskId: string, patch: Partial<TaskRecord>) {
    this.tasks.set(taskId, { ...(this.tasks.get(taskId) as TaskRecord), ...patch });
  }
  listTasks = vi.fn(async (_o: string, _filter: Record<string, unknown>, _page: unknown) =>
    [...this.tasks.values()].map((task) => ({ ...task, position: { key: task.id, id: task.id } })),
  );
  refreshCounters = vi.fn(async () => {});
  async insertActivity(activity: { type: string; organizationId: string; sourceEventId: string | null }) {
    const duplicate = this.activities.some(
      (a) => a.sourceEventId === activity.sourceEventId && a.organizationId === activity.organizationId,
    );
    if (duplicate) return false;
    this.activities.push(activity);
    return true;
  }
  listActivities = vi.fn(async (_o: string, businessId: string, page: { limit: number }) =>
    Array.from({ length: Math.min(page.limit, 3) }, (_, i) => ({
      id: id(100 + i),
      businessId: businessId as Activity['businessId'],
      type: 'note.added',
      actor: { type: 'user' as const, id: USER },
      data: {},
      occurredAt: NOW.toISOString(),
      position: { occurredAt: '2026-10-14T12:00:00.000000Z', id: id(100 + i) },
    })),
  );
  async workspacesTracking() {
    return [ORG, OTHER];
  }
  async repointMerged(fromId: string, toId: string) {
    this.repointed.push([fromId, toId]);
  }
  board = vi.fn(async () => [
    {
      status: 'qualified' as const,
      count: 1,
      cards: [
        {
          ...record(1, { pipelineStatus: 'qualified', nextTaskDueAt: NOW, statusChangedAt: NOW }),
          primaryCategoryId: null,
          locality: 'Gustavia',
          score: 70,
          tier: 'A',
        },
      ],
    },
  ]);
}

function setup(members: readonly string[] = [USER, OTHER]) {
  const repository = new FakeRepository();
  const recorded: Array<{ type: string; payload: unknown }> = [];
  const events = {
    record: vi.fn(async (definition: { type: string }, input: { payload: unknown }) => {
      recorded.push({ type: definition.type, payload: input.payload });
    }),
  } as unknown as EventRecorder;
  const directory = { isMember: vi.fn(async (_o: string, userId: string) => members.includes(userId)) };
  const clock = fixedClock(NOW);
  const crm = new CrmService(repository, events, directory as unknown as MemberDirectory, clock);
  return { repository, recorded, crm, queries: new CrmQueries(repository, clock) };
}

describe('CrmService pipeline', () => {
  it('moves through the table, records an event, and rejects stale or invalid moves', async () => {
    const { repository, recorded, crm } = setup();
    repository.records.set(id(1), record(1));
    const state = await crm.changeStatus(auth(), id(1), { status: 'qualified' });
    expect(state).toMatchObject({ pipelineStatus: 'qualified', statusChangedAt: NOW.toISOString() });
    expect(recorded).toEqual([
      {
        type: OrgBusinessStatusChanged.type,
        payload: { businessId: id(1), from: 'new', to: 'qualified', reason: null, automatic: false },
      },
    ]);
    await expect(crm.changeStatus(auth(), id(1), { status: 'won' })).rejects.toBeInstanceOf(
      InvalidStateTransitionError,
    );
    await expect(crm.changeStatus(auth(), id(1), { status: 'disqualified' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    repository.lose = true;
    await expect(crm.changeStatus(auth(), id(1), { status: 'contacted' })).rejects.toBeInstanceOf(
      InvalidStateTransitionError,
    );
    await expect(crm.state(auth(), id(9))).rejects.toBeInstanceOf(NotFoundError);
    await expect(crm.state({ ...auth(), orgId: null } as AuthContext, id(1))).rejects.toThrow(
      /without an active workspace/,
    );
  });

  it('makes automatic moves only where they apply', async () => {
    const { repository, crm } = setup();
    const pipeline = new CrmPipeline(crm);
    repository.records.set(id(1), record(1, { pipelineStatus: 'qualified' }));
    expect(await pipeline.markContacted(ORG, id(1))).toBe(true);
    expect(await pipeline.markContacted(ORG, id(1))).toBe(false);
    expect(await pipeline.markEngaged(ORG, id(1))).toBe(true);
    expect(await pipeline.markContacted(ORG, id(1))).toBe(false); // engaged → contacted is not a move
    expect(await pipeline.markEngaged(ORG, id(2))).toBe(false); // not tracked
    repository.records.set(id(3), record(3, { pipelineStatus: 'qualified' }));
    repository.changeStatus = async () => {
      throw new Error('database down');
    };
    await expect(pipeline.markContacted(ORG, id(3))).rejects.toThrow('database down');
  });

  it('applies bulk changes one at a time and reports domain refusals', async () => {
    const { repository, crm } = setup();
    repository.records.set(id(1), record(1));
    repository.records.set(id(2), record(2, { pipelineStatus: 'qualified' }));
    repository.records.set(id(3), record(3, { pipelineStatus: 'won' }));
    const result = await crm.bulkStatus(auth(), [id(1), id(2), id(3), id(4), id(1)], 'qualified', undefined);
    expect(result).toEqual({
      changed: 1,
      unchanged: 1,
      failed: [
        { businessId: id(3), code: 'INVALID_STATE_TRANSITION' },
        { businessId: id(4), code: 'NOT_FOUND' },
      ],
    });
    const tags = await crm.bulkTags(auth(), [id(1), id(2)], ['VIP'], []);
    expect(tags).toEqual({ changed: 2, unchanged: 0, failed: [] });
    expect((await crm.bulkTags(auth(), [id(1)], ['vip'], [])).unchanged).toBe(1);
    repository.setTags = async () => {
      throw new Error('boom');
    };
    await expect(crm.bulkTags(auth(), [id(1)], [], ['VIP'])).rejects.toThrow('boom');
  });
});

describe('CrmService owner, tags, do-not-contact', () => {
  it('assigns members only and records changes once', async () => {
    const { repository, recorded, crm } = setup();
    repository.records.set(id(1), record(1));
    expect((await crm.assignOwner(auth(), id(1), { ownerUserId: OTHER })).ownerUserId).toBe(OTHER);
    await crm.assignOwner(auth(), id(1), { ownerUserId: OTHER });
    await crm.assignOwner(auth(), id(1), { ownerUserId: null });
    expect(recorded.map((e) => e.payload)).toEqual([
      { businessId: id(1), ownerUserId: OTHER },
      { businessId: id(1), ownerUserId: null },
    ]);
    await expect(crm.assignOwner(auth(), id(1), { ownerUserId: id(77) })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('dedupes tags case-insensitively and caps them', async () => {
    const { repository, recorded, crm } = setup();
    repository.records.set(id(1), record(1, { tags: ['Old'] }));
    const state = await crm.updateTags(auth(), id(1), { add: [' VIP ', 'vip', 'old'], remove: [] });
    expect(state.tags).toEqual(['Old', 'VIP']);
    await crm.updateTags(auth(), id(1), { add: [], remove: ['OLD'] });
    expect(recorded.map((e) => e.payload)).toEqual([
      { businessId: id(1), added: ['VIP'], removed: [] },
      { businessId: id(1), added: [], removed: ['Old'] },
    ]);
    repository.records.set(id(2), record(2, { tags: Array.from({ length: 30 }, (_, i) => `t${i}`) }));
    await expect(crm.updateTags(auth(), id(2), { add: ['one more'], remove: [] })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('records do-not-contact changes with their reason', async () => {
    const { repository, recorded, crm } = setup();
    repository.records.set(id(1), record(1));
    await crm.setDoNotContact(auth(), id(1), { doNotContact: true, reason: ' Asked ' });
    await crm.setDoNotContact(auth(), id(1), { doNotContact: true, reason: 'Asked' });
    await crm.setDoNotContact(auth(), id(1), { doNotContact: false, reason: 'ignored' });
    expect(recorded).toEqual([
      { type: DoNotContactSet.type, payload: { businessId: id(1), doNotContact: true, reason: 'Asked' } },
      { type: DoNotContactSet.type, payload: { businessId: id(1), doNotContact: false, reason: null } },
    ]);
  });
});

describe('CrmService notes and tasks', () => {
  it('lets only the author change a note and refreshes counters', async () => {
    const { repository, crm } = setup();
    repository.records.set(id(1), record(1));
    const note = await crm.addNote(auth(), id(1), { bodyMarkdown: 'Hello', pinned: false });
    expect(note).toMatchObject({ authorId: USER, bodyMarkdown: 'Hello', createdAt: NOW.toISOString() });
    expect(await crm.notes(auth(), id(1))).toHaveLength(1);
    await expect(crm.updateNote(auth(OTHER), note.id, { pinned: true })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect((await crm.updateNote(auth(), note.id, { pinned: true })).pinned).toBe(true);
    await expect(crm.deleteNote(auth(OTHER), note.id)).rejects.toBeInstanceOf(ForbiddenError);
    await crm.deleteNote(auth(), note.id);
    await expect(crm.deleteNote(auth(), note.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(repository.refreshCounters).toHaveBeenCalledTimes(2);
  });

  it('creates tasks for members, completes them once', async () => {
    const { repository, recorded, crm } = setup();
    repository.records.set(id(1), record(1));
    const task = await crm.addTask(auth(), id(1), {
      type: 'call',
      title: 'Call',
      dueAt: '2026-10-15T09:00:00+02:00',
    });
    expect(task).toMatchObject({ assigneeId: USER, dueAt: '2026-10-15T07:00:00.000Z', status: 'open' });
    await expect(
      crm.addTask(auth(), id(1), { type: 'call', title: 'x', assigneeId: id(77) }),
    ).rejects.toBeInstanceOf(ValidationError);
    const noUser = await crm.addTask(auth(null), id(1), { type: 'other', title: 'By key' });
    expect(noUser.assigneeId).toBeNull();
    const done = await crm.updateTask(auth(), task.id, { status: 'done', title: 'Called' });
    expect(done).toMatchObject({ status: 'done', completedAt: NOW.toISOString(), title: 'Called' });
    const again = await crm.updateTask(auth(), task.id, { status: 'done' });
    expect(again.completedAt).toBe(NOW.toISOString()); // unchanged, no second event
    const reopened = await crm.updateTask(auth(), task.id, { status: 'open', dueAt: null, type: 'email' });
    expect(reopened).toMatchObject({ status: 'open', completedAt: null, dueAt: null, type: 'email' });
    await crm.updateTask(auth(), task.id, { assigneeId: OTHER });
    await expect(crm.updateTask(auth(), task.id, { assigneeId: id(77) })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(crm.updateTask(auth(), id(99), { title: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    expect(recorded.filter((e) => e.type === TaskCompleted.type)).toHaveLength(1);
  });
});

describe('CrmQueries', () => {
  it('pages activities with a cursor and validates it', async () => {
    const { repository, queries } = setup();
    repository.records.set(id(1), record(1));
    const first = await queries.activities(auth(), id(1), { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.items[0]).not.toHaveProperty('position');
    expect(first.nextCursor).not.toBeNull();
    await queries.activities(auth(), id(1), { limit: 2, cursor: first.nextCursor as string });
    expect(repository.listActivities).toHaveBeenLastCalledWith(ORG, id(1), {
      limit: 3,
      after: { occurredAt: '2026-10-14T12:00:00.000000Z', id: id(101) },
    });
    const last = await queries.activities(auth(), id(1), { limit: 5 });
    expect(last.nextCursor).toBeNull();
    const bad = await encodeCursor({ sort: ['yesterday'], id: id(1) });
    await expect(queries.activities(auth(), id(1), { limit: 2, cursor: bad })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(queries.activities(auth(), id(9), { limit: 2 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('lists tasks for me, someone, or a business', async () => {
    const { repository, crm, queries } = setup();
    repository.records.set(id(1), record(1));
    for (const title of ['a', 'b', 'c']) await crm.addTask(auth(), id(1), { type: 'call', title });
    const page = await queries.tasks(auth(), TaskQuerySchema.parse({ limit: 2 }));
    expect(page.items).toHaveLength(2);
    expect(repository.listTasks).toHaveBeenLastCalledWith(
      ORG,
      { assigneeId: USER, due: 'all', status: 'open', now: NOW, timeZone: 'UTC' },
      { limit: 3 },
    );
    await queries.tasks(auth(), TaskQuerySchema.parse({ cursor: page.nextCursor, assignee: OTHER }));
    expect(repository.listTasks.mock.lastCall?.[1]).toMatchObject({ assigneeId: OTHER });
    await queries.tasks(auth(), TaskQuerySchema.parse({}), id(1));
    expect(repository.listTasks.mock.lastCall?.[1]).toMatchObject({ assigneeId: null, businessId: id(1) });
    await expect(queries.tasks(auth(), TaskQuerySchema.parse({}), id(9))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const tooLong = await encodeCursor({ sort: ['x'.repeat(81)], id: id(1) });
    await expect(queries.tasks(auth(), TaskQuerySchema.parse({ cursor: tooLong }))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('maps the board and resolves owner=me', async () => {
    const { repository, queries } = setup();
    const board = await queries.board(auth(), {
      owner: 'me',
      tag: 'vip',
      category: id(5),
      tier: 'A',
      limit: 10,
    });
    expect(repository.board).toHaveBeenLastCalledWith(ORG, {
      limit: 10,
      ownerUserId: USER,
      tag: 'vip',
      categoryId: id(5),
      tier: 'A',
    });
    expect(board.columns[0]?.cards[0]).toMatchObject({
      businessId: id(1),
      nextTaskDueAt: NOW.toISOString(),
      allowedTransitions: expect.arrayContaining([{ to: 'contacted', requiresReason: false }]),
    });
    await queries.board(auth(), { owner: OTHER, limit: 5 });
    expect(repository.board).toHaveBeenLastCalledWith(ORG, { limit: 5, ownerUserId: OTHER });
  });
});

describe('ActivitySubscriber', () => {
  const event = <P>(type: string, payload: P, orgId: string | null = ORG, eventId = id(500)) =>
    ({
      id: eventId,
      type,
      version: 1,
      orgId,
      actor: { type: 'user', id: USER },
      occurredAt: NOW.toISOString(),
      payload,
    }) as unknown as DomainEvent<never>;

  it('records one activity per event and workspace, and publishes it', async () => {
    const repository = new FakeRepository();
    const realtime = { publish: vi.fn(async () => {}) };
    const subscriber = new ActivitySubscriber(repository, realtime as unknown as RealtimePublisher);
    const changed = event(OrgBusinessStatusChanged.type, {
      businessId: id(1),
      from: 'new',
      to: 'qualified',
      reason: null,
      automatic: false,
    });
    await subscriber.record(changed);
    await subscriber.record(changed); // redelivery
    await subscriber.record(event(BusinessCreated.type, { businessId: id(1), source: 'manual' }, null));
    await subscriber.record(event('something.else', { businessId: id(1) }));
    expect(repository.activities.map((a) => a.type)).toEqual(['status.changed']);
    expect(realtime.publish).toHaveBeenCalledTimes(1);
    expect(realtime.publish).toHaveBeenCalledWith(ORG, expect.objectContaining({ entityId: id(1) }));
  });

  it('maps every built-in event', async () => {
    const repository = new FakeRepository();
    const subscriber = new ActivitySubscriber(repository, { publish: async () => {} } as never);
    const payloads: Array<[string, Record<string, unknown>]> = [
      ['org_business.owner.changed', { ownerUserId: null }],
      ['org_business.tags.changed', { added: ['a'], removed: [] }],
      ['crm.do_not_contact.set', { doNotContact: true, reason: 'x' }],
      ['crm.note.added', { noteId: id(2) }],
      ['crm.task.created', { taskId: id(3), title: 't', dueAt: null }],
      ['crm.task.completed', { taskId: id(3), title: 't' }],
      ['business.created', { source: 'manual' }],
    ];
    for (const [i, [type, payload]] of payloads.entries())
      await subscriber.record(event(type, { businessId: id(1), ...payload }, ORG, id(600 + i)));
    expect(repository.activities.map((a) => a.type)).toEqual([
      'owner.changed',
      'tags.changed',
      'do_not_contact.changed',
      'note.added',
      'task.created',
      'task.completed',
      'business.tracked',
    ]);
  });

  it('notes updated facts in every tracking workspace', async () => {
    const repository = new FakeRepository();
    const subscriber = new ActivitySubscriber(repository, { publish: async () => {} } as never);
    await subscriber.updated(event('business.updated', { businessId: id(1), fields: ['websiteUrl'] }, null));
    expect(repository.activities.map((a) => [a.organizationId, a.type])).toEqual([
      [ORG, 'business.updated'],
      [OTHER, 'business.updated'],
    ]);
  });

  it('re-points merged records and notes the merge in every tracking workspace', async () => {
    const repository = new FakeRepository();
    const subscriber = new ActivitySubscriber(repository, { publish: async () => {} } as never);
    await subscriber.merged(event(BusinessMerged.type, { businessId: id(2), intoId: id(1) }, null));
    expect(repository.repointed).toEqual([[id(2), id(1)]]);
    expect(repository.refreshCounters).toHaveBeenCalledTimes(2);
    expect(repository.activities.map((a) => [a.organizationId, a.type])).toEqual([
      [ORG, 'business.merged'],
      [OTHER, 'business.merged'],
    ]);
  });
});
