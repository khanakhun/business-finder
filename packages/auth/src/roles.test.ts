import { PERMISSIONS, ROLE_PERMISSIONS } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { fromStatements, isRole, roles, toStatements } from './roles.ts';

describe('organization plugin roles', () => {
  it('lets only holders of members:manage manage members and invitations', () => {
    expect(roles.owner.authorize({ member: ['delete'], invitation: ['create'] }).success).toBe(true);
    expect(roles.admin.authorize({ member: ['update'], invitation: ['cancel'] }).success).toBe(true);
    expect(roles.member.authorize({ invitation: ['create'] }).success).toBe(false);
    expect(roles.viewer.authorize({ member: ['delete'] }).success).toBe(false);
  });

  it('keeps organization deletion for owners', () => {
    expect(roles.owner.authorize({ organization: ['delete'] }).success).toBe(true);
    expect(roles.admin.authorize({ organization: ['delete'] }).success).toBe(false);
  });

  it('recognises our role names only', () => {
    expect(['owner', 'admin', 'member', 'viewer'].every(isRole)).toBe(true);
    expect(isRole('client')).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});

describe('permission statements', () => {
  it('round-trips every role’s permissions', () => {
    for (const permissions of Object.values(ROLE_PERMISSIONS)) {
      const list = [...permissions];
      expect(new Set(fromStatements(toStatements(list)))).toEqual(new Set(list));
    }
    expect(fromStatements(toStatements([...PERMISSIONS]))).toEqual([...PERMISSIONS]);
  });

  it('groups actions by resource', () => {
    expect(toStatements(['business:read', 'business:write', 'leads:read'])).toEqual({
      business: ['read', 'write'],
      leads: ['read'],
    });
  });

  it('drops unknown pairs and handles empty input (fail closed)', () => {
    expect(fromStatements({ business: ['read', 'nuke'], files: ['read'] })).toEqual(['business:read']);
    expect(fromStatements(null)).toEqual([]);
  });
});
