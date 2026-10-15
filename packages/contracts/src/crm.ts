import { z } from 'zod';
import { PipelineStatusSchema } from './business.ts';
import { ActorSchema, defineEvent } from './events.ts';
import { BusinessId } from './ids.ts';
import { CursorPageRequestSchema, cursorPage } from './pagination.ts';
import { IsoDateTimeSchema } from './time.ts';

// CRM basics (BF-024): the workspace's pipeline state machine, owner, tags, do-not-contact, notes, tasks and the
// activity timeline. Global facts stay in the business graph (ADR-0008).

export const REASON_STATUSES = ['lost', 'disqualified'] as const;

/** A move the caller may make from the current status (the UI shows exactly these). */
export const PipelineTransitionSchema = z.object({
  to: PipelineStatusSchema,
  requiresReason: z.boolean(),
});
export type PipelineTransition = z.infer<typeof PipelineTransitionSchema>;

const ReasonSchema = z.string().trim().min(1).max(500);

export const CrmStateSchema = z
  .object({
    businessId: BusinessId,
    pipelineStatus: PipelineStatusSchema,
    statusChangedAt: IsoDateTimeSchema.nullable(),
    allowedTransitions: z.array(PipelineTransitionSchema),
    disqualifiedReason: z.string().nullable(),
    lostReason: z.string().nullable(),
    ownerUserId: z.uuid().nullable(),
    tags: z.array(z.string()),
    doNotContact: z.boolean(),
    doNotContactReason: z.string().nullable(),
    notesCount: z.number().int().nonnegative(),
    openTasksCount: z.number().int().nonnegative(),
    nextTaskDueAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'CrmState' });
export type CrmState = z.infer<typeof CrmStateSchema>;

export const ChangeStatusRequestSchema = z.object({
  status: PipelineStatusSchema,
  reason: ReasonSchema.optional().describe('Required for lost and disqualified.'),
});
export type ChangeStatusRequest = z.output<typeof ChangeStatusRequestSchema>;

export const AssignOwnerRequestSchema = z.object({ ownerUserId: z.uuid().nullable() });
export type AssignOwnerRequest = z.output<typeof AssignOwnerRequestSchema>;

const TagSchema = z.string().trim().min(1).max(50);
export const UpdateTagsRequestSchema = z
  .object({ add: z.array(TagSchema).max(20).default([]), remove: z.array(TagSchema).max(20).default([]) })
  .refine((r) => r.add.length + r.remove.length > 0, { message: 'Nothing to change' });
export type UpdateTagsRequest = z.output<typeof UpdateTagsRequestSchema>;

export const DoNotContactRequestSchema = z
  .object({ doNotContact: z.boolean(), reason: ReasonSchema.optional() })
  .refine((r) => !r.doNotContact || r.reason !== undefined, {
    message: 'A reason is required',
    path: ['reason'],
  });
export type DoNotContactRequest = z.output<typeof DoNotContactRequestSchema>;

// --- Bulk (search results, BF-023 registry) -------------------------------------------------------------------

const BusinessIdsSchema = z.array(z.uuid()).min(1).max(1_000);

export const BulkStatusRequestSchema = z.object({
  businessIds: BusinessIdsSchema,
  status: PipelineStatusSchema,
  reason: ReasonSchema.optional(),
});
export type BulkStatusRequest = z.output<typeof BulkStatusRequestSchema>;

export const BulkTagsRequestSchema = z
  .object({
    businessIds: BusinessIdsSchema,
    add: z.array(TagSchema).max(20).default([]),
    remove: z.array(TagSchema).max(20).default([]),
  })
  .refine((r) => r.add.length + r.remove.length > 0, { message: 'Nothing to change' });
export type BulkTagsRequest = z.output<typeof BulkTagsRequestSchema>;

export const BulkResultSchema = z
  .object({
    changed: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    failed: z.array(z.object({ businessId: z.uuid(), code: z.string() })),
  })
  .meta({ id: 'BulkResult' });
export type BulkResult = z.infer<typeof BulkResultSchema>;

// --- Notes ------------------------------------------------------------------------------------------------------

export const NoteSchema = z
  .object({
    id: z.uuid(),
    businessId: BusinessId,
    authorId: z.uuid().nullable(),
    bodyMarkdown: z.string(),
    pinned: z.boolean(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .meta({ id: 'Note' });
export type Note = z.infer<typeof NoteSchema>;
export const NoteListSchema = z.object({ items: z.array(NoteSchema) }).meta({ id: 'NoteList' });
export type NoteList = z.infer<typeof NoteListSchema>;

const MarkdownSchema = z.string().trim().min(1).max(20_000);
export const CreateNoteRequestSchema = z.object({
  bodyMarkdown: MarkdownSchema,
  pinned: z.boolean().default(false),
});
export type CreateNoteRequest = z.output<typeof CreateNoteRequestSchema>;
export const UpdateNoteRequestSchema = z
  .object({ bodyMarkdown: MarkdownSchema, pinned: z.boolean() })
  .partial()
  .refine((r) => Object.keys(r).length > 0, { message: 'Nothing to update' });
export type UpdateNoteRequest = z.output<typeof UpdateNoteRequestSchema>;

// --- Tasks ------------------------------------------------------------------------------------------------------

export const TASK_TYPES = ['call', 'email', 'visit', 'follow_up', 'other'] as const;
export const CRM_TASK_STATUSES = ['open', 'done', 'cancelled'] as const;
export const TaskTypeSchema = z.enum(TASK_TYPES);
export const CrmTaskStatusSchema = z.enum(CRM_TASK_STATUSES);

export const TaskSchema = z
  .object({
    id: z.uuid(),
    businessId: BusinessId,
    businessName: z.string(),
    assigneeId: z.uuid().nullable(),
    createdBy: z.uuid().nullable(),
    type: TaskTypeSchema,
    title: z.string(),
    dueAt: IsoDateTimeSchema.nullable(),
    status: CrmTaskStatusSchema,
    completedAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'Task' });
export type Task = z.infer<typeof TaskSchema>;
export const TaskPageSchema = cursorPage(TaskSchema).meta({ id: 'TaskPage' });
export type TaskPage = z.infer<typeof TaskPageSchema>;

export const CreateTaskRequestSchema = z.object({
  type: TaskTypeSchema.default('follow_up'),
  title: z.string().trim().min(1).max(200),
  dueAt: z.iso.datetime({ offset: true }).optional(),
  assigneeId: z.uuid().optional().describe('Default: the caller.'),
});
export type CreateTaskRequest = z.output<typeof CreateTaskRequestSchema>;

export const UpdateTaskRequestSchema = z
  .object({
    type: TaskTypeSchema,
    title: z.string().trim().min(1).max(200),
    dueAt: z.iso.datetime({ offset: true }).nullable(),
    assigneeId: z.uuid().nullable(),
    status: CrmTaskStatusSchema,
  })
  .partial()
  .refine((r) => Object.keys(r).length > 0, { message: 'Nothing to update' });
export type UpdateTaskRequest = z.output<typeof UpdateTaskRequestSchema>;

export const TASK_DUE_FILTERS = ['today', 'overdue', 'upcoming', 'all'] as const;
export const TaskQuerySchema = CursorPageRequestSchema.extend({
  assignee: z.union([z.literal('me'), z.uuid()]).default('me'),
  due: z.enum(TASK_DUE_FILTERS).default('all'),
  status: CrmTaskStatusSchema.default('open'),
});
export type TaskQuery = z.output<typeof TaskQuerySchema>;

// --- Activities -------------------------------------------------------------------------------------------------

/** Built-in activity types; later tickets add theirs (and a renderer in the web registry). */
export const ACTIVITY_TYPES = [
  'business.tracked',
  'status.changed',
  'owner.changed',
  'tags.changed',
  'do_not_contact.changed',
  'note.added',
  'task.created',
  'task.completed',
  'business.merged',
] as const;

export const ActivitySchema = z
  .object({
    id: z.uuid(),
    businessId: BusinessId,
    type: z.string().describe(`Built-in: ${ACTIVITY_TYPES.join(', ')}; later tickets add more.`),
    actor: ActorSchema,
    data: z.record(z.string(), z.unknown()),
    occurredAt: IsoDateTimeSchema,
  })
  .meta({ id: 'Activity' });
export type Activity = z.infer<typeof ActivitySchema>;
export const ActivityPageSchema = cursorPage(ActivitySchema).meta({ id: 'ActivityPage' });
export type ActivityPage = z.infer<typeof ActivityPageSchema>;

// --- Pipeline board ---------------------------------------------------------------------------------------------

export const PipelineCardSchema = z.object({
  businessId: BusinessId,
  displayName: z.string(),
  primaryCategoryId: z.uuid().nullable(),
  locality: z.string().nullable(),
  score: z.number().int().nullable(),
  tier: z.string().nullable(),
  ownerUserId: z.uuid().nullable(),
  nextTaskDueAt: IsoDateTimeSchema.nullable(),
  statusChangedAt: IsoDateTimeSchema.nullable(),
  allowedTransitions: z.array(PipelineTransitionSchema),
});
export const PipelineBoardSchema = z
  .object({
    columns: z.array(
      z.object({
        status: PipelineStatusSchema,
        count: z.number().int().nonnegative(),
        cards: z.array(PipelineCardSchema),
      }),
    ),
  })
  .meta({ id: 'PipelineBoard' });
export type PipelineBoard = z.infer<typeof PipelineBoardSchema>;

export const PipelineQuerySchema = z.object({
  owner: z.union([z.literal('me'), z.uuid()]).optional(),
  tag: z.string().max(50).optional(),
  category: z.uuid().optional().describe('Includes its subcategories.'),
  tier: z.enum(['A', 'B', 'C', 'X']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50).describe('Cards per column.'),
});
export type PipelineQuery = z.output<typeof PipelineQuerySchema>;

// --- Events -----------------------------------------------------------------------------------------------------

export const OrgBusinessStatusChanged = defineEvent(
  'org_business.status.changed',
  1,
  z.object({
    businessId: BusinessId,
    from: PipelineStatusSchema,
    to: PipelineStatusSchema,
    reason: z.string().nullable(),
    automatic: z.boolean(),
  }),
);
export const OrgBusinessOwnerChanged = defineEvent(
  'org_business.owner.changed',
  1,
  z.object({ businessId: BusinessId, ownerUserId: z.uuid().nullable() }),
);
export const OrgBusinessTagsChanged = defineEvent(
  'org_business.tags.changed',
  1,
  z.object({ businessId: BusinessId, added: z.array(z.string()), removed: z.array(z.string()) }),
);
/** Compliance (BF-049) subscribes: do-not-contact suppresses outreach to the business. */
export const DoNotContactSet = defineEvent(
  'crm.do_not_contact.set',
  1,
  z.object({ businessId: BusinessId, doNotContact: z.boolean(), reason: z.string().nullable() }),
);
export const NoteAdded = defineEvent(
  'crm.note.added',
  1,
  z.object({ businessId: BusinessId, noteId: z.uuid() }),
);
export const TaskCreated = defineEvent(
  'crm.task.created',
  1,
  z.object({
    businessId: BusinessId,
    taskId: z.uuid(),
    title: z.string(),
    dueAt: IsoDateTimeSchema.nullable(),
  }),
);
export const TaskCompleted = defineEvent(
  'crm.task.completed',
  1,
  z.object({ businessId: BusinessId, taskId: z.uuid(), title: z.string() }),
);

/** Realtime: a new activity on a business (the detail page refreshes its timeline). */
export const CRM_ACTIVITY_CREATED = 'crm.activity.created';
