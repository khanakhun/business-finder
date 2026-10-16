import { ConflictError, ForbiddenError, type Role } from '@bf/contracts';

/**
 * Who may grant which role, and the last-owner rule. Pure: callers load the facts (roles, owner count) and the
 * use case applies the decision. The route-level `members:manage` permission is checked before these rules.
 */

export interface MembershipFacts {
  readonly memberId: string;
  readonly role: Role;
}

/** Roles `actor` may hand out: owners anything, admins anything but owner, others nothing. */
export function assignableRoles(actor: Role): readonly Role[] {
  if (actor === 'owner') return ['owner', 'admin', 'member', 'viewer'];
  if (actor === 'admin') return ['admin', 'member', 'viewer'];
  return [];
}

export function assertCanInvite(actor: Role, role: Role): void {
  if (!assignableRoles(actor).includes(role)) {
    throw new ForbiddenError(`A ${actor} cannot invite someone as ${role}.`, {
      details: { reason: 'ROLE_NOT_ASSIGNABLE' },
    });
  }
}

function assertCanManage(actor: MembershipFacts, target: MembershipFacts): void {
  if (target.role === 'owner' && actor.role !== 'owner') {
    throw new ForbiddenError('Only an owner can change or remove another owner.', {
      details: { reason: 'OWNER_PROTECTED' },
    });
  }
}

function assertKeepsAnOwner(target: MembershipFacts, ownerCount: number): void {
  if (target.role === 'owner' && ownerCount <= 1) {
    throw new ConflictError('A workspace needs at least one owner. Transfer ownership first.', {
      details: { reason: 'LAST_OWNER' },
    });
  }
}

/** Changing `target`'s role to `next` (including your own). */
export function assertCanChangeRole(
  actor: MembershipFacts,
  target: MembershipFacts,
  next: Role,
  ownerCount: number,
): void {
  if (target.role === next) return;
  assertCanManage(actor, target);
  if (!assignableRoles(actor.role).includes(next)) {
    throw new ForbiddenError(`A ${actor.role} cannot grant the ${next} role.`, {
      details: { reason: 'ROLE_NOT_ASSIGNABLE' },
    });
  }
  assertKeepsAnOwner(target, ownerCount);
}

/** Removing `target` from the workspace (including leaving it yourself). */
export function assertCanRemove(actor: MembershipFacts, target: MembershipFacts, ownerCount: number): void {
  assertCanManage(actor, target);
  assertKeepsAnOwner(target, ownerCount);
}

/** Ownership transfer: owner only, to another member; the previous owner becomes admin. */
export function planOwnershipTransfer(
  actor: MembershipFacts,
  target: MembershipFacts,
): { readonly promote: string; readonly demote: string } {
  if (actor.role !== 'owner') {
    throw new ForbiddenError('Only an owner can transfer ownership.', { details: { reason: 'NOT_OWNER' } });
  }
  if (actor.memberId === target.memberId) {
    throw new ConflictError('You already own this workspace.', { details: { reason: 'SAME_MEMBER' } });
  }
  return { promote: target.memberId, demote: actor.memberId };
}
