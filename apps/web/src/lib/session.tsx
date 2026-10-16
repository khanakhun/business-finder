'use client';

import type { Me, Permission } from '@bf/contracts';
import * as React from 'react';

const SessionContext = React.createContext<Me | null>(null);

/** Provided by the dashboard layout from the server-side `/v1/me` check. */
export function SessionProvider({ me, children }: { readonly me: Me; readonly children: React.ReactNode }) {
  return <SessionContext.Provider value={me}>{children}</SessionContext.Provider>;
}

export function useSession(): Me {
  const me = React.useContext(SessionContext);
  if (!me) throw new Error('useSession() outside the dashboard (no SessionProvider)');
  return me;
}

/**
 * Whether the signed-in user may do `permission` in the active workspace. Hides/disables UI only — the API
 * enforces every permission itself.
 */
export function usePermission(permission: Permission): boolean {
  return useSession().permissions.includes(permission);
}
