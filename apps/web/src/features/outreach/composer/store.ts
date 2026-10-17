'use client';

import * as React from 'react';

// Which business the composer is open for (BF-051): any entry point (business header, listing row, lead) calls
// `openComposer`; the one host in the dashboard layout renders the drawer.

export interface ComposerTarget {
  readonly businessId: string;
  readonly businessName?: string;
  readonly contactId?: string;
}

let current: ComposerTarget | null = null;
const listeners = new Set<() => void>();

export function openComposer(target: ComposerTarget): void {
  current = target;
  for (const listener of listeners) listener();
}

export function closeComposer(): void {
  current = null;
  for (const listener of listeners) listener();
}

export function useComposerTarget(): ComposerTarget | null {
  return React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}
