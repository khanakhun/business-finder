import {
  type ActivityPage,
  ActivityPageSchema,
  AssignOwnerRequestSchema,
  type BulkResult,
  BulkResultSchema,
  BulkStatusRequestSchema,
  BulkTagsRequestSchema,
  ChangeStatusRequestSchema,
  CreateNoteRequestSchema,
  CreateTaskRequestSchema,
  type CrmState,
  CrmStateSchema,
  CursorPageRequestSchema,
  DoNotContactRequestSchema,
  type Note,
  type NoteList,
  NoteListSchema,
  NoteSchema,
  type PipelineBoard,
  PipelineBoardSchema,
  PipelineQuerySchema,
  type Task,
  type TaskPage,
  TaskPageSchema,
  TaskQuerySchema,
  TaskSchema,
  UpdateNoteRequestSchema,
  UpdateTagsRequestSchema,
  UpdateTaskRequestSchema,
} from '@bf/contracts';
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { CrmQueries } from '../../application/crm.queries.ts';
import { CrmService } from '../../application/crm.service.ts';

class StatusBody extends zodDto(ChangeStatusRequestSchema) {}
class OwnerBody extends zodDto(AssignOwnerRequestSchema) {}
class TagsBody extends zodDto(UpdateTagsRequestSchema) {}
class DoNotContactBody extends zodDto(DoNotContactRequestSchema) {}
class BulkStatusBody extends zodDto(BulkStatusRequestSchema) {}
class BulkTagsBody extends zodDto(BulkTagsRequestSchema) {}
class NoteBody extends zodDto(CreateNoteRequestSchema) {}
class NotePatch extends zodDto(UpdateNoteRequestSchema) {}
class TaskBody extends zodDto(CreateTaskRequestSchema) {}
class TaskPatch extends zodDto(UpdateTaskRequestSchema) {}
class PageQuery extends zodDto(CursorPageRequestSchema) {}
class TasksQuery extends zodDto(TaskQuerySchema) {}
class BoardQuery extends zodDto(PipelineQuerySchema) {}

const uuid = new ParseUUIDPipe({ version: '7' });

/** The workspace's CRM on a tracked business (BF-024). */
@ApiTags('crm')
@Controller()
export class CrmController {
  constructor(
    private readonly crm: CrmService,
    private readonly queries: CrmQueries,
  ) {}

  // Static paths first: they must win over `businesses/:id` routes.
  @Post('businesses/bulk/status')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Move up to 1,000 businesses to a pipeline status (each one checked; refusals reported)',
    operationId: 'bulkChangeStatus',
    body: BulkStatusBody,
    response: { status: 200, schema: BulkResultSchema },
    errors: [401, 403],
  })
  bulkStatus(@Ctx() auth: AuthContext, @Body() body: BulkStatusBody): Promise<BulkResult> {
    return this.crm.bulkStatus(auth, body.businessIds, body.status, body.reason);
  }

  @Post('businesses/bulk/tags')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Add or remove tags on up to 1,000 businesses',
    operationId: 'bulkUpdateTags',
    body: BulkTagsBody,
    response: { status: 200, schema: BulkResultSchema },
    errors: [401, 403],
  })
  bulkTags(@Ctx() auth: AuthContext, @Body() body: BulkTagsBody): Promise<BulkResult> {
    return this.crm.bulkTags(auth, body.businessIds, body.add, body.remove);
  }

  @Get('businesses/:id/crm')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: "The workspace's CRM state of a business, with the pipeline moves allowed from it",
    operationId: 'getCrmState',
    response: { status: 200, schema: CrmStateSchema },
    errors: [400, 401, 403, 404],
  })
  state(@Ctx() auth: AuthContext, @Param('id', uuid) id: string): Promise<CrmState> {
    return this.crm.state(auth, id);
  }

  @Post('businesses/:id/status')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Move a business through the pipeline (reason required for lost and disqualified)',
    operationId: 'changeStatus',
    body: StatusBody,
    response: { status: 200, schema: CrmStateSchema },
    errors: [400, 401, 403, 404, 409],
  })
  changeStatus(
    @Ctx() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body() body: StatusBody,
  ): Promise<CrmState> {
    return this.crm.changeStatus(auth, id, body);
  }

  @Put('businesses/:id/owner')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Assign (or clear) the workspace member who owns a business',
    operationId: 'assignOwner',
    body: OwnerBody,
    response: { status: 200, schema: CrmStateSchema },
    errors: [400, 401, 403, 404],
  })
  owner(@Ctx() auth: AuthContext, @Param('id', uuid) id: string, @Body() body: OwnerBody): Promise<CrmState> {
    return this.crm.assignOwner(auth, id, body);
  }

  @Post('businesses/:id/tags')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Add and remove tags',
    operationId: 'updateTags',
    body: TagsBody,
    response: { status: 200, schema: CrmStateSchema },
    errors: [400, 401, 403, 404],
  })
  tags(@Ctx() auth: AuthContext, @Param('id', uuid) id: string, @Body() body: TagsBody): Promise<CrmState> {
    return this.crm.updateTags(auth, id, body);
  }

  @Put('businesses/:id/do-not-contact')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Mark (with a reason) or unmark a business as do-not-contact',
    operationId: 'setDoNotContact',
    body: DoNotContactBody,
    response: { status: 200, schema: CrmStateSchema },
    errors: [400, 401, 403, 404],
  })
  doNotContact(
    @Ctx() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body() body: DoNotContactBody,
  ): Promise<CrmState> {
    return this.crm.setDoNotContact(auth, id, body);
  }

  @Get('businesses/:id/activities')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'The business timeline, newest first',
    operationId: 'listActivities',
    query: PageQuery,
    response: { status: 200, schema: ActivityPageSchema },
    errors: [400, 401, 403, 404],
  })
  activities(
    @Ctx() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Query() query: PageQuery,
  ): Promise<ActivityPage> {
    return this.queries.activities(auth, id, query);
  }

  @Get('businesses/:id/notes')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'Notes on a business (pinned first)',
    operationId: 'listNotes',
    response: { status: 200, schema: NoteListSchema },
    errors: [400, 401, 403, 404],
  })
  async notes(@Ctx() auth: AuthContext, @Param('id', uuid) id: string): Promise<NoteList> {
    return { items: await this.crm.notes(auth, id) };
  }

  @Post('businesses/:id/notes')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Add a note (markdown; rendered sanitized)',
    operationId: 'createNote',
    body: NoteBody,
    response: { status: 201, schema: NoteSchema },
    errors: [400, 401, 403, 404],
  })
  addNote(@Ctx() auth: AuthContext, @Param('id', uuid) id: string, @Body() body: NoteBody): Promise<Note> {
    return this.crm.addNote(auth, id, body);
  }

  @Patch('notes/:id')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Edit or pin a note (author only)',
    operationId: 'updateNote',
    body: NotePatch,
    response: { status: 200, schema: NoteSchema },
    errors: [400, 401, 403, 404],
  })
  updateNote(
    @Ctx() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body() body: NotePatch,
  ): Promise<Note> {
    return this.crm.updateNote(auth, id, body);
  }

  @Delete('notes/:id')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Delete a note (author only)',
    operationId: 'deleteNote',
    response: { status: 204, schema: null },
    errors: [400, 401, 403, 404],
  })
  async deleteNote(@Ctx() auth: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    await this.crm.deleteNote(auth, id);
  }

  @Get('businesses/:id/tasks')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: "A business's tasks (any assignee)",
    operationId: 'listBusinessTasks',
    query: TasksQuery,
    response: { status: 200, schema: TaskPageSchema },
    errors: [400, 401, 403, 404],
  })
  businessTasks(
    @Ctx() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Query() query: TasksQuery,
  ): Promise<TaskPage> {
    return this.queries.tasks(auth, query, id);
  }

  @Post('businesses/:id/tasks')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Add a task (assigned to the caller by default)',
    operationId: 'createTask',
    body: TaskBody,
    response: { status: 201, schema: TaskSchema },
    errors: [400, 401, 403, 404],
  })
  addTask(@Ctx() auth: AuthContext, @Param('id', uuid) id: string, @Body() body: TaskBody): Promise<Task> {
    return this.crm.addTask(auth, id, body);
  }

  @Get('tasks')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'Tasks by assignee (me by default) and due window, soonest first',
    operationId: 'listTasks',
    query: TasksQuery,
    response: { status: 200, schema: TaskPageSchema },
    errors: [401, 403],
  })
  tasks(@Ctx() auth: AuthContext, @Query() query: TasksQuery): Promise<TaskPage> {
    return this.queries.tasks(auth, query);
  }

  @Patch('tasks/:id')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Edit, reassign, complete or cancel a task',
    operationId: 'updateTask',
    body: TaskPatch,
    response: { status: 200, schema: TaskSchema },
    errors: [400, 401, 403, 404],
  })
  updateTask(
    @Ctx() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body() body: TaskPatch,
  ): Promise<Task> {
    return this.crm.updateTask(auth, id, body);
  }

  @Get('pipeline')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'The pipeline board: counts and the most recently moved cards per status',
    operationId: 'getPipelineBoard',
    query: BoardQuery,
    response: { status: 200, schema: PipelineBoardSchema },
    errors: [401, 403],
  })
  board(@Ctx() auth: AuthContext, @Query() query: BoardQuery): Promise<PipelineBoard> {
    return this.queries.board(auth, query);
  }
}
