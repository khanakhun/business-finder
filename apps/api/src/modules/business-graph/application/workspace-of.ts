import type { AuthContext } from '../../platform/security/auth-context.ts';

/** Routes guarantee an active workspace (`@RequirePermission`); reaching here without one is a wiring bug. */
export function workspaceOf(auth: AuthContext): string {
  if (!auth.orgId) throw new Error('Business route reached without an active workspace');
  return auth.orgId;
}
