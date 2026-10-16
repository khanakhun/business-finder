'use client';

import { type BaseOperation, BaseOperationSchema } from '@bf/site-schema';
import { z } from 'zod';
import { DRAFTS_DB } from './clear-drafts.ts';

// The editor's unsaved work, kept in the browser (BF-037): the operations since the version it started from, so a
// reload or a crash never loses it. One draft per person, workspace and site (never offered to someone else on a
// shared computer), checked on read, forgotten after a week, and erased on sign-out (`clearAllDrafts`).
// IndexedDB may be missing or refused (private windows): every call then does nothing and resolves.

export interface DraftOwner {
  readonly userId: string;
  readonly organizationId: string;
  readonly siteId: string;
}

export interface LocalDraft extends DraftOwner {
  readonly baseVersionId: string;
  readonly baseVersionNumber: number;
  readonly operations: readonly BaseOperation[];
  readonly pageId: string;
  readonly savedAt: string;
}

const STORE = 'drafts';
const VERSION = 2;
/** Unsaved work older than this is not offered back (and is erased). */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const DraftSchema = z.object({
  key: z.string(),
  userId: z.string(),
  organizationId: z.string(),
  siteId: z.string(),
  baseVersionId: z.string(),
  baseVersionNumber: z.number().int().positive(),
  operations: z.array(BaseOperationSchema).min(1).max(5_000),
  pageId: z.string().max(40),
  savedAt: z.iso.datetime(),
});

const keyOf = (owner: DraftOwner) => `${owner.userId}:${owner.organizationId}:${owner.siteId}`;

function open(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(undefined);
      const request = indexedDB.open(DRAFTS_DB, VERSION);
      request.onupgradeneeded = () => {
        // Drafts of the first format (one per site, whoever wrote it) are dropped.
        if (request.result.objectStoreNames.contains(STORE)) request.result.deleteObjectStore(STORE);
        request.result.createObjectStore(STORE, { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

async function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const request = work(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    } finally {
      db.close();
    }
  });
}

/** This person's draft of this site in this workspace, if valid and recent (anything else is erased). */
export async function readDraft(owner: DraftOwner, now = Date.now()): Promise<LocalDraft | undefined> {
  const stored = await run<unknown>('readonly', (store) => store.get(keyOf(owner)));
  if (stored === undefined) return undefined;
  const parsed = DraftSchema.safeParse(stored);
  const draft = parsed.success ? parsed.data : undefined;
  if (
    !draft ||
    draft.userId !== owner.userId ||
    draft.organizationId !== owner.organizationId ||
    draft.siteId !== owner.siteId ||
    now - Date.parse(draft.savedAt) > DRAFT_MAX_AGE_MS
  ) {
    await clearDraft(owner);
    return undefined;
  }
  return draft;
}

export async function writeDraft(draft: LocalDraft): Promise<void> {
  await run('readwrite', (store) => store.put({ ...draft, key: keyOf(draft) }));
}

export async function clearDraft(owner: DraftOwner): Promise<void> {
  await run('readwrite', (store) => store.delete(keyOf(owner)));
}
