import { ForbiddenError, type Role } from '@bf/contracts';
import type { AuthContext } from '../../platform/security/auth-context.ts';

/** A signed-in user acting in their active workspace (membership changes are never made with API keys). */
export interface MemberActor {
  readonly userId: string;
  readonly orgId: string;
  readonly role: Role;
}

export function memberActor(auth: AuthContext): MemberActor {
  if (auth.method !== 'session' || !auth.userId || !auth.orgId || !auth.role) {
    throw new ForbiddenError('This action needs a signed-in member, not an API key.');
  }
  return { userId: auth.userId, orgId: auth.orgId, role: auth.role };
}

/** The signed-in user's id; API keys have no user to describe. */
export function sessionUserId(auth: AuthContext): string {
  if (auth.method !== 'session' || !auth.userId) {
    throw new ForbiddenError('This endpoint describes a signed-in user; API keys have none.');
  }
  return auth.userId;
}
