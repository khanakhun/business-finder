import type { BusinessSort, SavedFilters, SearchIntent } from '@bf/contracts';

/** Keyset position for "newest first" pages of saved searches and lists. */
export interface CreatedPosition {
  /** `created_at` as microsecond ISO text. */
  readonly createdAt: string;
  readonly id: string;
}

export interface SavedSearchRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly createdBy: string | null;
  readonly name: string;
  readonly prompt: string | null;
  readonly intent: SearchIntent | null;
  readonly filters: SavedFilters;
  readonly sort: BusinessSort | null;
  readonly visibility: 'private' | 'workspace';
  readonly notifyNew: boolean;
  readonly lastRunAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly position: CreatedPosition;
}

/** Absent (or undefined) fields stay as they are. */
export type SavedSearchPatch = {
  readonly [K in 'name' | 'prompt' | 'intent' | 'filters' | 'sort' | 'visibility' | 'notifyNew']?:
    | SavedSearchRecord[K]
    | undefined;
};

export interface SavedSearchRepository {
  /** Newest first: the workspace's shared searches plus the viewer's private ones. */
  list(
    organizationId: string,
    viewerId: string | null,
    page: { readonly limit: number; readonly after?: CreatedPosition },
  ): Promise<SavedSearchRecord[]>;
  /** A saved search the viewer may see (shared, or private and theirs). */
  find(organizationId: string, viewerId: string | null, id: string): Promise<SavedSearchRecord | undefined>;
  count(organizationId: string): Promise<number>;
  insert(
    record: Omit<SavedSearchRecord, 'createdAt' | 'updatedAt' | 'position' | 'lastRunAt'>,
  ): Promise<void>;
  update(organizationId: string, id: string, patch: SavedSearchPatch): Promise<void>;
  markRun(organizationId: string, id: string, at: Date): Promise<void>;
  delete(organizationId: string, id: string): Promise<void>;
}
export const SAVED_SEARCH_REPOSITORY = Symbol('SavedSearchRepository');

export interface ListRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdBy: string | null;
  readonly itemCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly position: CreatedPosition;
}

export interface ListRepository {
  list(
    organizationId: string,
    page: { readonly limit: number; readonly after?: CreatedPosition },
  ): Promise<ListRecord[]>;
  find(organizationId: string, id: string): Promise<ListRecord | undefined>;
  /** False when the workspace already has a list with this name. */
  insert(record: {
    readonly id: string;
    readonly organizationId: string;
    readonly name: string;
    readonly description: string | null;
    readonly createdBy: string | null;
  }): Promise<boolean>;
  /** False when the new name is taken. */
  update(
    organizationId: string,
    id: string,
    patch: { readonly name?: string | undefined; readonly description?: string | null | undefined },
  ): Promise<boolean>;
  delete(organizationId: string, id: string): Promise<void>;
  /** Adds tracked businesses; returns how many were new and which ids the workspace does not track. */
  addItems(
    organizationId: string,
    listId: string,
    businessIds: readonly string[],
    addedBy: string | null,
  ): Promise<{ readonly added: number; readonly notTracked: string[] }>;
  removeItems(listId: string, businessIds: readonly string[]): Promise<number>;
}
export const LIST_REPOSITORY = Symbol('ListRepository');
