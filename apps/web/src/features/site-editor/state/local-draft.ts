'use client';

import type { BaseOperation } from '@bf/site-schema';

// The editor's unsaved work, kept in the browser (BF-037): the operations since the version it started from, so a
// reload or a crash never loses it. One draft per site; restoring replays it on the version open now (a rebase).
// IndexedDB may be missing or refused (private windows): every call then does nothing and resolves.

export interface LocalDraft {
  readonly siteId: string;
  readonly baseVersionId: string;
  readonly baseVersionNumber: number;
  readonly operations: readonly BaseOperation[];
  readonly pageId: string;
  readonly savedAt: string;
}

const DB = 'bf-site-editor';
const STORE = 'drafts';

function open(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(undefined);
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'siteId' });
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

export async function readDraft(siteId: string): Promise<LocalDraft | undefined> {
  const draft = await run<LocalDraft | undefined>('readonly', (store) => store.get(siteId));
  return draft && Array.isArray(draft.operations) && draft.operations.length > 0 ? draft : undefined;
}

export async function writeDraft(draft: LocalDraft): Promise<void> {
  await run('readwrite', (store) => store.put(draft));
}

export async function clearDraft(siteId: string): Promise<void> {
  await run('readwrite', (store) => store.delete(siteId));
}
