import { z } from 'zod';

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/** Every permission (DOMAIN.md §5). `<resource>:<action>`; read-only ones end in `:read`. */
export const PERMISSIONS = [
  'business:read',
  'business:write',
  'discovery:run',
  'sites:read',
  'sites:generate',
  'sites:publish',
  'sites:admin',
  'leads:read',
  'leads:manage',
  'leads:export',
  'outreach:send',
  'outreach:auto_send',
  'templates:manage',
  'analytics:read',
  'analytics:export',
  'settings:manage',
  'scoring:manage',
  'compliance:manage',
  'members:manage',
  'billing:manage',
] as const;
export const PermissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof PermissionSchema>;

const READ: Permission[] = ['business:read', 'sites:read', 'leads:read', 'analytics:read'];
const MEMBER: Permission[] = [
  ...READ,
  'business:write',
  'discovery:run',
  'sites:generate',
  'sites:publish',
  'leads:manage',
  'outreach:send',
];
const ADMIN: Permission[] = [
  ...MEMBER,
  'sites:admin',
  'leads:export',
  'outreach:auto_send',
  'templates:manage',
  'analytics:export',
  'settings:manage',
  'scoring:manage',
  'members:manage',
];

/** The RBAC matrix used by API guards and the UI. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  owner: new Set(PERMISSIONS),
  admin: new Set(ADMIN),
  member: new Set(MEMBER),
  viewer: new Set(READ),
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
