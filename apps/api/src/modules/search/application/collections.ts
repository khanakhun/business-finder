import {
  BusinessFiltersSchema,
  type BusinessList,
  type BusinessListPage,
  type Clock,
  ConflictError,
  type CreateListRequest,
  type CreateSavedSearchRequest,
  type CursorPageRequest,
  decodeCursor,
  encodeCursor,
  ForbiddenError,
  type ListItemsResult,
  NotFoundError,
  newId,
  type SavedSearch,
  type SavedSearchPage,
  type UpdateListRequest,
  type UpdateSavedSearchRequest,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import {
  type CreatedPosition,
  LIST_REPOSITORY,
  type ListRecord,
  type ListRepository,
  SAVED_SEARCH_REPOSITORY,
  type SavedSearchRecord,
  type SavedSearchRepository,
} from './collection-ports.ts';
import { ListingResolver } from './listing.queries.ts';

// Saved searches and lists (BF-022): workspace-scoped collections over the listing.

const workspaceOf = (auth: AuthContext): string => {
  if (!auth.orgId) throw new Error('Collection route reached without an active workspace');
  return auth.orgId;
};

/** Per workspace: bounds the work behind the saved searches page. */
export const MAX_SAVED_SEARCHES = 500;

const CREATED_AT = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

async function createdPositionOf(cursor: string): Promise<CreatedPosition> {
  const data = await decodeCursor(cursor);
  const [at, ...rest] = data.sort;
  const year = typeof at === 'string' ? Number(CREATED_AT.exec(at)?.[1]) : Number.NaN;
  if (rest.length > 0 || !(year >= 2000 && year <= 2100) || !z.uuid().safeParse(data.id).success) {
    throw new ValidationError('Invalid cursor.', [{ path: ['cursor'], message: 'Invalid cursor' }]);
  }
  return { createdAt: at as string, id: data.id };
}

async function pageOf<R extends { readonly position: CreatedPosition }, T>(
  rows: readonly R[],
  limit: number,
  map: (row: R) => Promise<T> | T,
): Promise<{ items: T[]; nextCursor: string | null }> {
  const page = rows.slice(0, limit);
  const last = rows.length > limit ? page.at(-1) : undefined;
  return {
    items: await Promise.all(page.map(map)),
    nextCursor: last ? await encodeCursor({ sort: [last.position.createdAt], id: last.position.id }) : null,
  };
}

@Injectable()
export class SavedSearches {
  constructor(
    @Inject(SAVED_SEARCH_REPOSITORY) private readonly repository: SavedSearchRepository,
    private readonly listing: ListingResolver,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(auth: AuthContext, page: CursorPageRequest): Promise<SavedSearchPage> {
    const after = page.cursor ? await createdPositionOf(page.cursor) : undefined;
    const rows = await this.repository.list(workspaceOf(auth), auth.userId, {
      limit: page.limit + 1,
      ...(after ? { after } : {}),
    });
    return pageOf(rows, page.limit, (row) => this.view(auth, row, false));
  }

  async get(auth: AuthContext, id: string): Promise<SavedSearch> {
    return this.view(auth, await this.visible(auth, id));
  }

  async create(auth: AuthContext, request: CreateSavedSearchRequest): Promise<SavedSearch> {
    const organizationId = workspaceOf(auth);
    if ((await this.repository.count(organizationId)) >= MAX_SAVED_SEARCHES) {
      throw new ConflictError(`A workspace keeps at most ${MAX_SAVED_SEARCHES} saved searches.`);
    }
    const id = newId();
    await this.repository.insert({
      id,
      organizationId,
      createdBy: auth.userId,
      name: request.name,
      prompt: request.prompt ?? null,
      intent: request.intent ?? null,
      filters: request.filters,
      sort: request.sort ?? null,
      visibility: request.visibility,
      notifyNew: request.notifyNew,
    });
    return this.get(auth, id);
  }

  async update(auth: AuthContext, id: string, patch: UpdateSavedSearchRequest): Promise<SavedSearch> {
    await this.owned(auth, id);
    await this.repository.update(workspaceOf(auth), id, patch);
    return this.get(auth, id);
  }

  async delete(auth: AuthContext, id: string): Promise<void> {
    await this.owned(auth, id);
    await this.repository.delete(workspaceOf(auth), id);
  }

  /**
   * Opening a saved search: returns it with the new matches until now, and — when the caller created it — restarts
   * the count from now (a shared search's count belongs to its creator, so others only read it).
   */
  async run(auth: AuthContext, id: string): Promise<SavedSearch> {
    const record = await this.visible(auth, id);
    const view = await this.view(auth, record);
    if (view.mine) await this.repository.markRun(workspaceOf(auth), id, this.clock.now());
    return view;
  }

  private async visible(auth: AuthContext, id: string): Promise<SavedSearchRecord> {
    const record = await this.repository.find(workspaceOf(auth), auth.userId, id);
    if (!record) throw new NotFoundError('SavedSearch', id);
    return record;
  }

  /** Only the creator changes a search (a shared one is read-only for the rest of the workspace). */
  private async owned(auth: AuthContext, id: string): Promise<SavedSearchRecord> {
    const record = await this.visible(auth, id);
    if (!auth.userId || record.createdBy !== auth.userId) {
      throw new ForbiddenError('Only the creator of a saved search can change it.');
    }
    return record;
  }

  private async view(auth: AuthContext, record: SavedSearchRecord, count = true): Promise<SavedSearch> {
    return {
      id: record.id,
      name: record.name,
      prompt: record.prompt,
      intent: record.intent,
      filters: record.filters,
      sort: record.sort,
      visibility: record.visibility,
      notifyNew: record.notifyNew,
      lastRunAt: record.lastRunAt?.toISOString() ?? null,
      newMatches: count ? await this.newMatches(record) : null,
      createdBy: record.createdBy,
      mine: auth.userId !== null && record.createdBy === auth.userId,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  /** Matches tracked since the last run; a search whose area was deleted matches nothing. */
  private async newMatches(record: SavedSearchRecord): Promise<number> {
    const filters = BusinessFiltersSchema.parse(record.filters);
    let spec: Awaited<ReturnType<ListingResolver['spec']>>;
    try {
      spec = await this.listing.spec(record.organizationId, filters);
    } catch (error) {
      if (error instanceof NotFoundError) return 0;
      throw error;
    }
    const since = [spec.addedSince, record.lastRunAt].filter((d): d is Date => d !== null);
    const addedSince = since.length > 0 ? new Date(Math.max(...since.map((d) => d.getTime()))) : null;
    return this.listing.count({ ...spec, addedSince });
  }
}

const toList = (record: ListRecord): BusinessList => ({
  id: record.id,
  name: record.name,
  description: record.description,
  itemCount: record.itemCount,
  createdBy: record.createdBy,
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});

@Injectable()
export class BusinessLists {
  constructor(@Inject(LIST_REPOSITORY) private readonly repository: ListRepository) {}

  async list(auth: AuthContext, page: CursorPageRequest): Promise<BusinessListPage> {
    const after = page.cursor ? await createdPositionOf(page.cursor) : undefined;
    const rows = await this.repository.list(workspaceOf(auth), {
      limit: page.limit + 1,
      ...(after ? { after } : {}),
    });
    return pageOf(rows, page.limit, toList);
  }

  async get(auth: AuthContext, id: string): Promise<BusinessList> {
    return toList(await this.found(auth, id));
  }

  async create(auth: AuthContext, request: CreateListRequest): Promise<BusinessList> {
    const id = newId();
    const created = await this.repository.insert({
      id,
      organizationId: workspaceOf(auth),
      name: request.name,
      description: request.description ?? null,
      createdBy: auth.userId,
    });
    if (!created) throw new ConflictError(`A list named "${request.name}" already exists.`);
    return this.get(auth, id);
  }

  async update(auth: AuthContext, id: string, patch: UpdateListRequest): Promise<BusinessList> {
    await this.found(auth, id);
    if (!(await this.repository.update(workspaceOf(auth), id, patch))) {
      throw new ConflictError(`A list named "${patch.name}" already exists.`);
    }
    return this.get(auth, id);
  }

  async delete(auth: AuthContext, id: string): Promise<void> {
    await this.found(auth, id);
    await this.repository.delete(workspaceOf(auth), id);
  }

  async addItems(auth: AuthContext, id: string, businessIds: readonly string[]): Promise<ListItemsResult> {
    await this.found(auth, id);
    const unique = new Set(businessIds);
    const { added, notTracked } = await this.repository.addItems(
      workspaceOf(auth),
      id,
      [...unique],
      auth.userId,
    );
    const after = await this.found(auth, id);
    return {
      changed: added,
      unchanged: unique.size - added - notTracked.length,
      notTracked,
      itemCount: after.itemCount,
    };
  }

  async removeItems(auth: AuthContext, id: string, businessIds: readonly string[]): Promise<ListItemsResult> {
    await this.found(auth, id);
    const unique = new Set(businessIds);
    const removed = await this.repository.removeItems(id, [...unique]);
    const after = await this.found(auth, id);
    return { changed: removed, unchanged: unique.size - removed, notTracked: [], itemCount: after.itemCount };
  }

  private async found(auth: AuthContext, id: string): Promise<ListRecord> {
    const record = await this.repository.find(workspaceOf(auth), id);
    if (!record) throw new NotFoundError('List', id);
    return record;
  }
}
