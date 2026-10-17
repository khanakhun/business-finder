'use client';

// The call list's offline outcome queue (BF-057), erased on sign-out. Kept apart from the queue so the dashboard shell
// (which signs out) does not load the API client's assist calls.

export const OUTCOMES_DB = 'bf-call-outcomes';

/** Erases the queue and the scripts kept for offline reading (nothing of the session stays on a shared computer). */
export function clearOutcomeQueue(): Promise<void> {
  try {
    for (const key of Object.keys(window.localStorage))
      if (key.startsWith('bf-call-script:')) window.localStorage.removeItem(key);
  } catch {
    // Nothing kept.
  }
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve();
      const request = indexedDB.deleteDatabase(OUTCOMES_DB);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}
