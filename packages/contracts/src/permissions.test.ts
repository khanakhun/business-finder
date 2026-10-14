import { describe, expect, it } from 'vitest';
import { can, PERMISSIONS, ROLE_PERMISSIONS, ROLES } from './permissions.ts';

describe('permission matrix', () => {
  it('gives owner every permission', () => {
    for (const permission of PERMISSIONS) expect(can('owner', permission)).toBe(true);
  });

  it('gives viewer only *:read permissions', () => {
    const viewer = [...ROLE_PERMISSIONS.viewer];
    expect(viewer.length).toBeGreaterThan(0);
    for (const permission of viewer) expect(permission).toMatch(/:read$/);
    for (const permission of PERMISSIONS.filter((p) => p.endsWith(':read')))
      expect(can('viewer', permission)).toBe(true);
  });

  it('is cumulative: viewer ⊂ member ⊂ admin ⊂ owner', () => {
    const order = ['viewer', 'member', 'admin', 'owner'] as const;
    for (let i = 1; i < order.length; i++) {
      const lower = ROLE_PERMISSIONS[order[i - 1] as (typeof order)[number]];
      const higher = ROLE_PERMISSIONS[order[i] as (typeof order)[number]];
      for (const permission of lower) expect(higher.has(permission)).toBe(true);
    }
  });

  it('matches DOMAIN.md §5 for the sensitive permissions', () => {
    expect(can('admin', 'compliance:manage')).toBe(false);
    expect(can('admin', 'billing:manage')).toBe(false);
    expect(can('member', 'sites:admin')).toBe(false);
    expect(can('member', 'outreach:auto_send')).toBe(false);
    expect(can('member', 'sites:publish')).toBe(true);
    expect(can('viewer', 'business:write')).toBe(false);
  });

  it('covers every role and only known permissions', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ROLES].sort());
    for (const set of Object.values(ROLE_PERMISSIONS)) {
      for (const permission of set) expect(PERMISSIONS).toContain(permission);
    }
  });
});
