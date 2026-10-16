'use client';

// The site editor's drafts database (BF-037), erased on sign-out. Kept apart from the drafts module so the dashboard
// shell (which signs out) does not load the SiteSpec schema.

export const DRAFTS_DB = 'bf-site-editor';

/** Erases every draft in this browser (unsaved work never outlives the session on a shared computer). */
export function clearAllDrafts(): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve();
      const request = indexedDB.deleteDatabase(DRAFTS_DB);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}
