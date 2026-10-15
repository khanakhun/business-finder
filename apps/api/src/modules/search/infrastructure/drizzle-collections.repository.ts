import type { SavedFilters, SearchIntent } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { listItems, lists, orgBusinesses, savedSearches } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type {
  CreatedPosition,
  ListRecord,
  ListRepository,
  SavedSearchPatch,
  SavedSearchRecord,
  SavedSearchRepository,
} from '../application/collection-ports.ts';
import { arrayOf } from './sql/business-search.sql.ts';

const createdText = (column: typeof savedSearches.createdAt | typeof lists.createdAt) =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Postgres unique violation (wrapped by Drizzle as the error's cause). */
const isUniqueViolation = (error: unknown) =>
  error instanceof Error &&
  [error, error.cause].some(
    (e) => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505',
  );

type SavedSearchRow = typeof savedSearches.$inferSelect;

const toSavedSearch = (row: SavedSearchRow, createdAt: string): SavedSearchRecord => ({
  id: row.id,
  organizationId: row.organizationId,
  createdBy: row.createdBy,
  name: row.name,
  prompt: row.prompt,
  intent: row.intent as SearchIntent | null,
  filters: row.filters as SavedFilters,
  sort: row.sort as SavedSearchRecord['sort'],
  visibility: row.visibility,
  notifyNew: row.notifyNew,
  lastRunAt: row.lastRunAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  position: { createdAt, id: row.id },
});

@Injectable()
export class DrizzleSavedSearchRepository implements SavedSearchRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private visible(organizationId: string, viewerId: string | null) {
    return and(
      eq(savedSearches.organizationId, organizationId),
      viewerId
        ? or(eq(savedSearches.visibility, 'workspace'), eq(savedSearches.createdBy, viewerId))
        : eq(savedSearches.visibility, 'workspace'),
    );
  }

  async list(
    organizationId: string,
    viewerId: string | null,
    page: { readonly limit: number; readonly after?: CreatedPosition },
  ): Promise<SavedSearchRecord[]> {
    const rows = await getExecutor(this.db)
      .select({ row: savedSearches, createdAt: createdText(savedSearches.createdAt) })
      .from(savedSearches)
      .where(
        and(
          this.visible(organizationId, viewerId),
          page.after
            ? sql`(${savedSearches.createdAt}, ${savedSearches.id}) < (${page.after.createdAt}::timestamptz, ${page.after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(savedSearches.createdAt), desc(savedSearches.id))
      .limit(page.limit);
    return rows.map((r) => toSavedSearch(r.row, r.createdAt));
  }

  async find(
    organizationId: string,
    viewerId: string | null,
    id: string,
  ): Promise<SavedSearchRecord | undefined> {
    const [row] = await getExecutor(this.db)
      .select({ row: savedSearches, createdAt: createdText(savedSearches.createdAt) })
      .from(savedSearches)
      .where(and(this.visible(organizationId, viewerId), eq(savedSearches.id, id)));
    return row ? toSavedSearch(row.row, row.createdAt) : undefined;
  }

  async insert(
    record: Omit<SavedSearchRecord, 'createdAt' | 'updatedAt' | 'position' | 'lastRunAt'>,
  ): Promise<void> {
    await getExecutor(this.db)
      .insert(savedSearches)
      .values({
        ...record,
        intent: record.intent as Record<string, unknown> | null,
        sort: record.sort ?? 'relevance',
      });
  }

  async update(organizationId: string, id: string, patch: SavedSearchPatch): Promise<void> {
    const { intent, sort, ...rest } = patch;
    await getExecutor(this.db)
      .update(savedSearches)
      .set({
        ...rest,
        ...(intent !== undefined ? { intent: intent as Record<string, unknown> | null } : {}),
        ...(sort !== undefined ? { sort: sort ?? 'relevance' } : {}),
      })
      .where(and(eq(savedSearches.organizationId, organizationId), eq(savedSearches.id, id)));
  }

  async markRun(organizationId: string, id: string, at: Date): Promise<void> {
    await getExecutor(this.db)
      .update(savedSearches)
      .set({ lastRunAt: at })
      .where(and(eq(savedSearches.organizationId, organizationId), eq(savedSearches.id, id)));
  }

  async delete(organizationId: string, id: string): Promise<void> {
    await getExecutor(this.db)
      .delete(savedSearches)
      .where(and(eq(savedSearches.organizationId, organizationId), eq(savedSearches.id, id)));
  }
}

@Injectable()
export class DrizzleListRepository implements ListRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private select() {
    return getExecutor(this.db)
      .select({
        list: lists,
        createdAt: createdText(lists.createdAt),
        itemCount: sql<number>`(SELECT count(*)::int FROM ${listItems} li WHERE li.list_id = ${lists.id})`,
      })
      .from(lists);
  }

  private static toRecord(row: {
    list: typeof lists.$inferSelect;
    createdAt: string;
    itemCount: number;
  }): ListRecord {
    return { ...row.list, itemCount: row.itemCount, position: { createdAt: row.createdAt, id: row.list.id } };
  }

  async list(
    organizationId: string,
    page: { readonly limit: number; readonly after?: CreatedPosition },
  ): Promise<ListRecord[]> {
    const rows = await this.select()
      .where(
        and(
          eq(lists.organizationId, organizationId),
          page.after
            ? sql`(${lists.createdAt}, ${lists.id}) < (${page.after.createdAt}::timestamptz, ${page.after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(lists.createdAt), desc(lists.id))
      .limit(page.limit);
    return rows.map(DrizzleListRepository.toRecord);
  }

  async find(organizationId: string, id: string): Promise<ListRecord | undefined> {
    const [row] = await this.select().where(and(eq(lists.organizationId, organizationId), eq(lists.id, id)));
    return row ? DrizzleListRepository.toRecord(row) : undefined;
  }

  async insert(record: {
    readonly id: string;
    readonly organizationId: string;
    readonly name: string;
    readonly description: string | null;
    readonly createdBy: string | null;
  }): Promise<boolean> {
    const inserted = await getExecutor(this.db)
      .insert(lists)
      .values(record)
      .onConflictDoNothing({ target: [lists.organizationId, lists.name] })
      .returning({ id: lists.id });
    return inserted.length > 0;
  }

  async update(
    organizationId: string,
    id: string,
    patch: { readonly name?: string | undefined; readonly description?: string | null | undefined },
  ): Promise<boolean> {
    try {
      await getExecutor(this.db)
        .update(lists)
        .set(patch)
        .where(and(eq(lists.organizationId, organizationId), eq(lists.id, id)));
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  async delete(organizationId: string, id: string): Promise<void> {
    await getExecutor(this.db)
      .delete(lists)
      .where(and(eq(lists.organizationId, organizationId), eq(lists.id, id)));
  }

  async addItems(
    organizationId: string,
    listId: string,
    businessIds: readonly string[],
    addedBy: string | null,
  ): Promise<{ readonly added: number; readonly notTracked: string[] }> {
    const executor = getExecutor(this.db);
    const tracked = new Set(
      (
        await executor
          .select({ id: orgBusinesses.businessId })
          .from(orgBusinesses)
          .where(
            and(
              eq(orgBusinesses.organizationId, organizationId),
              sql`${orgBusinesses.businessId} = ANY(${arrayOf(businessIds, 'uuid')})`,
            ),
          )
      ).map((r) => r.id),
    );
    const unique = [...new Set(businessIds)];
    const toAdd = unique.filter((id) => tracked.has(id));
    const inserted =
      toAdd.length === 0
        ? []
        : await executor
            .insert(listItems)
            .values(toAdd.map((businessId) => ({ listId, businessId, addedBy })))
            .onConflictDoNothing()
            .returning({ id: listItems.businessId });
    return { added: inserted.length, notTracked: unique.filter((id) => !tracked.has(id)) };
  }

  async removeItems(listId: string, businessIds: readonly string[]): Promise<number> {
    const removed = await getExecutor(this.db)
      .delete(listItems)
      .where(and(eq(listItems.listId, listId), inArray(listItems.businessId, [...businessIds])))
      .returning({ id: listItems.businessId });
    return removed.length;
  }
}
