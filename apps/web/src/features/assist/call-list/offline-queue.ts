'use client';

import type { LogOutcomeRequest, LogOutcomeResult } from '@bf/contracts';
import { postOutcome } from '../api.ts';
import { OUTCOMES_DB } from './clear-queue.ts';

// Outcomes logged without a connection (BF-057, offline-first queue): each one is kept in IndexedDB under its
// idempotency key and submitted again when the browser is back online; the API logs a key once, so a submit that
// reached the server before the connection dropped is not logged twice. Erased on sign-out with the rest of the
// session's local data. IndexedDB may be missing (private windows): the outcome is then only submitted directly.

const STORE = 'outcomes';

export interface QueuedOutcome {
  readonly key: string;
  readonly userId: string;
  readonly businessId: string;
  readonly body: LogOutcomeRequest;
  readonly queuedAt: string;
}

function open(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(undefined);
      const request = indexedDB.open(OUTCOMES_DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await open();
  if (!db) return undefined;
  return new Promise<T | undefined>((resolve) => {
    try {
      const request = work(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

export function onQueueChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function queued(userId: string): Promise<QueuedOutcome[]> {
  const all = (await run<QueuedOutcome[]>('readonly', (store) => store.getAll())) ?? [];
  return all.filter((item) => item.userId === userId);
}

/** A network failure (no answer at all), as opposed to a refusal by the API. */
const offline = (error: unknown) =>
  (typeof navigator !== 'undefined' && !navigator.onLine) || error instanceof TypeError;

/**
 * Submits an outcome, or queues it when offline. Resolves with the result, or `null` when queued; a refusal by the
 * API (validation, compliance) is thrown as is and nothing is queued.
 */
export async function submitOutcome(
  userId: string,
  businessId: string,
  body: LogOutcomeRequest,
): Promise<LogOutcomeResult | null> {
  try {
    return await postOutcome(businessId, body);
  } catch (error) {
    if (!offline(error)) throw error;
    const item: QueuedOutcome = {
      key: body.idempotencyKey,
      userId,
      businessId,
      body,
      queuedAt: new Date().toISOString(),
    };
    await run('readwrite', (store) => store.put(item));
    changed();
    return null;
  }
}

let flushing = false;

/** Submits the queued outcomes (once at a time); refused ones are dropped, unsent ones stay. Returns how many went. */
export async function flushOutcomes(userId: string): Promise<number> {
  if (flushing) return 0;
  flushing = true;
  let sent = 0;
  try {
    for (const item of await queued(userId)) {
      try {
        await postOutcome(item.businessId, item.body);
        sent++;
      } catch (error) {
        if (offline(error)) break;
        // Refused for good (e.g. the business became do-not-contact): it would never go.
      }
      await run('readwrite', (store) => store.delete(item.key));
    }
  } finally {
    flushing = false;
    changed();
  }
  return sent;
}

/** A key the API logs once (the queue re-submits it as is). */
export const newOutcomeKey = () => `call:${crypto.randomUUID()}`;
