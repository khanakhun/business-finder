import { ConflictError, ForbiddenError, type Role } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import {
  assertCanChangeRole,
  assertCanInvite,
  assertCanRemove,
  assignableRoles,
  planOwnershipTransfer,
} from './membership-policy.ts';

const m = (memberId: string, role: Role) => ({ memberId, role });
const reason = (fn: () => void) => {
  try {
    fn();
    return 'allowed';
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ConflictError)
      return String(error.details?.reason);
    throw error;
  }
};

describe('assignableRoles / assertCanInvite', () => {
  it.each([
    ['owner', ['owner', 'admin', 'member', 'viewer']],
    ['admin', ['admin', 'member', 'viewer']],
    ['member', []],
    ['viewer', []],
  ] as const)('%s can assign %j', (actor, roles) => {
    expect(assignableRoles(actor)).toEqual(roles);
  });

  it('refuses invitations for roles the inviter cannot grant', () => {
    expect(reason(() => assertCanInvite('admin', 'owner'))).toBe('ROLE_NOT_ASSIGNABLE');
    expect(reason(() => assertCanInvite('admin', 'viewer'))).toBe('allowed');
    expect(reason(() => assertCanInvite('owner', 'owner'))).toBe('allowed');
  });
});

describe('assertCanChangeRole', () => {
  it.each([
    // actor, target, next, owners, expected
    [m('a', 'owner'), m('b', 'member'), 'admin', 1, 'allowed'],
    [m('a', 'owner'), m('b', 'admin'), 'owner', 1, 'allowed'],
    [m('a', 'admin'), m('b', 'member'), 'viewer', 1, 'allowed'],
    [m('a', 'admin'), m('b', 'member'), 'owner', 1, 'ROLE_NOT_ASSIGNABLE'],
    [m('a', 'admin'), m('b', 'owner'), 'admin', 2, 'OWNER_PROTECTED'],
    [m('a', 'owner'), m('a', 'owner'), 'admin', 1, 'LAST_OWNER'],
    [m('a', 'owner'), m('a', 'owner'), 'admin', 2, 'allowed'],
    [m('a', 'owner'), m('b', 'owner'), 'member', 2, 'allowed'],
    [m('a', 'member'), m('b', 'viewer'), 'member', 1, 'ROLE_NOT_ASSIGNABLE'],
    [m('a', 'admin'), m('b', 'viewer'), 'viewer', 1, 'allowed'], // no-op
  ] as const)('%o changes %o to %s with %i owner(s) → %s', (actor, target, next, owners, expected) => {
    expect(reason(() => assertCanChangeRole(actor, target, next, owners))).toBe(expected);
  });
});

describe('assertCanRemove', () => {
  it.each([
    [m('a', 'owner'), m('b', 'member'), 1, 'allowed'],
    [m('a', 'admin'), m('b', 'viewer'), 1, 'allowed'],
    [m('a', 'admin'), m('b', 'owner'), 2, 'OWNER_PROTECTED'],
    [m('a', 'owner'), m('a', 'owner'), 1, 'LAST_OWNER'],
    [m('a', 'owner'), m('b', 'owner'), 2, 'allowed'],
    [m('a', 'member'), m('a', 'member'), 1, 'allowed'], // leaving
  ] as const)('%o removes %o with %i owner(s) → %s', (actor, target, owners, expected) => {
    expect(reason(() => assertCanRemove(actor, target, owners))).toBe(expected);
  });
});

describe('planOwnershipTransfer', () => {
  it('promotes the target and demotes the current owner to admin', () => {
    expect(planOwnershipTransfer(m('a', 'owner'), m('b', 'admin'))).toEqual({ promote: 'b', demote: 'a' });
  });

  it('is owner-only and needs another member', () => {
    expect(reason(() => planOwnershipTransfer(m('a', 'admin'), m('b', 'member')))).toBe('NOT_OWNER');
    expect(reason(() => planOwnershipTransfer(m('a', 'owner'), m('a', 'owner')))).toBe('SAME_MEMBER');
  });

  it('raises typed errors that map to 403 and 409', () => {
    expect(() => planOwnershipTransfer(m('a', 'viewer'), m('b', 'member'))).toThrow(ForbiddenError);
    expect(() => assertCanRemove(m('a', 'owner'), m('a', 'owner'), 1)).toThrow(ConflictError);
  });
});
