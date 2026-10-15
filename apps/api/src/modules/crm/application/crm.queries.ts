import {
  type ActivityPage,
  type Clock,
  type CursorPageRequest,
  decodeCursor,
  encodeCursor,
  NotFoundError,
  type PipelineBoard,
  type PipelineQuery,
  type TaskPage,
  type TaskQuery,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { allowedTransitions } from '../domain/pipeline.ts';
import { toTask } from './crm.service.ts';
import { CRM_REPOSITORY, type CrmRepository } from './ports.ts';

const workspaceOf = (auth: AuthContext): string => {
  if (!auth.orgId) throw new Error('CRM route reached without an active workspace');
  return auth.orgId;
};

const invalidCursor = () =>
  new ValidationError('Invalid cursor.', [{ path: ['cursor'], message: 'Invalid cursor' }]);
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

@Injectable()
export class CrmQueries {
  constructor(
    @Inject(CRM_REPOSITORY) private readonly repository: CrmRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async activities(auth: AuthContext, businessId: string, page: CursorPageRequest): Promise<ActivityPage> {
    const organizationId = workspaceOf(auth);
    if (!(await this.repository.get(organizationId, businessId)))
      throw new NotFoundError('Business', businessId);
    let after: { occurredAt: string; id: string } | undefined;
    if (page.cursor) {
      const data = await decodeCursor(page.cursor);
      const [at] = data.sort;
      if (typeof at !== 'string' || !STAMP.test(at)) throw invalidCursor();
      after = { occurredAt: at, id: data.id };
    }
    const rows = await this.repository.listActivities(organizationId, businessId, {
      limit: page.limit + 1,
      ...(after ? { after } : {}),
    });
    const items = rows.slice(0, page.limit);
    const last = rows.length > page.limit ? items.at(-1) : undefined;
    return {
      items: items.map(({ position: _position, ...activity }) => activity),
      nextCursor: last
        ? await encodeCursor({ sort: [last.position.occurredAt], id: last.position.id })
        : null,
    };
  }

  async tasks(auth: AuthContext, query: TaskQuery, businessId?: string): Promise<TaskPage> {
    const organizationId = workspaceOf(auth);
    if (businessId && !(await this.repository.get(organizationId, businessId)))
      throw new NotFoundError('Business', businessId);
    let after: { key: string; id: string } | undefined;
    if (query.cursor) {
      const data = await decodeCursor(query.cursor);
      const [key] = data.sort;
      if (typeof key !== 'string' || key.length > 80) throw invalidCursor();
      after = { key, id: data.id };
    }
    const assigneeId = businessId ? null : query.assignee === 'me' ? auth.userId : query.assignee;
    const rows = await this.repository.listTasks(
      organizationId,
      {
        assigneeId,
        due: query.due,
        status: query.status,
        now: this.clock.now(),
        timeZone: query.tz,
        ...(businessId ? { businessId } : {}),
      },
      { limit: query.limit + 1, ...(after ? { after } : {}) },
    );
    const items = rows.slice(0, query.limit);
    const last = rows.length > query.limit ? items.at(-1) : undefined;
    return {
      items: items.map(({ position: _position, ...task }) => toTask(task)),
      nextCursor: last ? await encodeCursor({ sort: [last.position.key], id: last.position.id }) : null,
    };
  }

  async board(auth: AuthContext, query: PipelineQuery): Promise<PipelineBoard> {
    const owner = query.owner === 'me' ? (auth.userId ?? undefined) : query.owner;
    const columns = await this.repository.board(workspaceOf(auth), {
      limit: query.limit,
      ...(owner ? { ownerUserId: owner } : {}),
      ...(query.tag ? { tag: query.tag } : {}),
      ...(query.category ? { categoryId: query.category } : {}),
      ...(query.tier ? { tier: query.tier } : {}),
    });
    return {
      columns: columns.map((column) => ({
        status: column.status,
        count: column.count,
        cards: column.cards.map((card) => ({
          businessId: card.businessId as never,
          displayName: card.displayName,
          primaryCategoryId: card.primaryCategoryId,
          locality: card.locality,
          score: card.score,
          tier: card.tier,
          ownerUserId: card.ownerUserId,
          nextTaskDueAt: card.nextTaskDueAt?.toISOString() ?? null,
          statusChangedAt: card.statusChangedAt?.toISOString() ?? null,
          allowedTransitions: allowedTransitions(card.pipelineStatus),
        })),
      })),
    };
  }
}
