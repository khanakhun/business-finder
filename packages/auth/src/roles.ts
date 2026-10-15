// Role definitions for Better Auth's organization plugin, plus conversions between our permission strings
// (`business:read`) and Better Auth "statements" (`{ business: ['read'] }`), used by API key permissions.
//
// What a role may do in the *application* is decided only by ROLE_PERMISSIONS in @bf/contracts. The plugin's
// access control below only governs its own endpoints (invite, change role, remove member…), and is derived
// from the same matrix: whoever holds `members:manage` may manage members and invitations.
import { can, PERMISSIONS, type Permission, ROLES, type Role } from '@bf/contracts';
import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements, memberAc, ownerAc } from 'better-auth/plugins/organization/access';

const API_KEY_ACTIONS = ['create', 'read', 'update', 'delete'] as const;

export const ac = createAccessControl({ ...defaultStatements, apiKey: API_KEY_ACTIONS });

/**
 * Owners keep organization deletion; other holders of `members:manage` get the admin statement set. API keys
 * (the api-key plugin checks `apiKey:<action>` on the member's role) follow `settings:manage`.
 */
function pluginStatements(role: Role) {
  const base =
    role === 'owner'
      ? ownerAc.statements
      : can(role, 'members:manage')
        ? adminAc.statements
        : memberAc.statements;
  return can(role, 'settings:manage') ? { ...base, apiKey: [...API_KEY_ACTIONS] } : base;
}

/** Better Auth role objects keyed by our role names. */
export const roles = {
  owner: ac.newRole(pluginStatements('owner')),
  admin: ac.newRole(pluginStatements('admin')),
  member: ac.newRole(pluginStatements('member')),
  viewer: ac.newRole(pluginStatements('viewer')),
} satisfies Record<Role, unknown>;

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** `['business:read', 'leads:read']` → `{ business: ['read'], leads: ['read'] }`. */
export function toStatements(permissions: readonly Permission[]): Record<string, string[]> {
  const statements: Record<string, string[]> = {};
  for (const permission of permissions) {
    const [resource = '', action = ''] = permission.split(':');
    const actions = statements[resource] ?? [];
    actions.push(action);
    statements[resource] = actions;
  }
  return statements;
}

/** Inverse of `toStatements`; unknown pairs are dropped (fail closed). */
export function fromStatements(
  statements: Readonly<Record<string, readonly string[]>> | null | undefined,
): Permission[] {
  if (!statements) return [];
  const permissions = Object.entries(statements).flatMap(([resource, actions]) =>
    actions.map((action) => `${resource}:${action}`),
  );
  return PERMISSIONS.filter((p) => permissions.includes(p));
}
