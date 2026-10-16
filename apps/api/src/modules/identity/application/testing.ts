// In-memory adapters for unit-testing identity use cases (the Drizzle adapters are covered by identity.int.test.ts).

import { type Permission, ROLE_PERMISSIONS, type Role } from '@bf/contracts';
import type { DbClient } from '@bf/db';
import { setTransactionalDb } from '../../platform/db/transactional.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import type {
  ApiKeyIssuer,
  ApiKeyRecord,
  ApiKeyRepository,
  IdentityEvent,
  IdentityEvents,
  InvitationRecord,
  MemberRecord,
  MembershipRepository,
  OrganizationRecord,
  SystemMailer,
  UserRecord,
} from './ports.ts';

/** `@Transactional()` needs a client; a fake that runs the callback is enough without a database. */
export function useFakeTransactions(): void {
  setTransactionalDb({ transaction: (fn: (tx: unknown) => unknown) => fn({}) } as unknown as DbClient);
}

let counter = 0;
export const uuid = () => `00000000-0000-7000-8000-${String(++counter).padStart(12, '0')}`;

export function session(userId: string, orgId: string | null, role: Role | null): AuthContext {
  return {
    method: 'session',
    userId,
    apiKeyId: null,
    orgId,
    role,
    permissions: role ? ROLE_PERMISSIONS[role] : new Set(),
    crossOrigin: false,
    operator: false,
  };
}

export function apiKeyAuth(orgId: string, permissions: Permission[]): AuthContext {
  return {
    method: 'api_key',
    userId: null,
    apiKeyId: uuid(),
    orgId,
    role: null,
    permissions: new Set(permissions),
    crossOrigin: false,
    operator: false,
  };
}

export class InMemoryMembers implements MembershipRepository {
  users = new Map<string, UserRecord>();
  orgs = new Map<string, OrganizationRecord>();
  members: MemberRecord[] = [];
  invitations: InvitationRecord[] = [];

  addUser(name: string, email = `${name.toLowerCase()}@example.test`): UserRecord {
    const user = {
      id: uuid(),
      name,
      email,
      emailVerified: true,
      image: null,
      locale: 'en' as const,
      twoFactorEnabled: false,
    };
    this.users.set(user.id, user);
    return user;
  }

  addOrg(name: string): OrganizationRecord {
    const org = { id: uuid(), name, slug: name.toLowerCase() };
    this.orgs.set(org.id, org);
    return org;
  }

  join(user: UserRecord, org: OrganizationRecord, role: Role): MemberRecord {
    const member = {
      id: uuid(),
      organizationId: org.id,
      userId: user.id,
      role,
      name: user.name,
      email: user.email,
      image: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
    };
    this.members.push(member);
    return member;
  }

  async findUser(userId: string) {
    return this.users.get(userId);
  }
  async findOrganization(organizationId: string) {
    return this.orgs.get(organizationId);
  }
  async organizationsOf(userId: string) {
    return this.members
      .filter((m) => m.userId === userId)
      .map((m) => ({ ...(this.orgs.get(m.organizationId) as OrganizationRecord), role: m.role }));
  }
  async roleOf(userId: string, organizationId: string) {
    return this.members.find((m) => m.userId === userId && m.organizationId === organizationId)?.role;
  }
  async listMembers(organizationId: string) {
    return this.members.filter((m) => m.organizationId === organizationId);
  }
  async findMember(organizationId: string, memberId: string) {
    return this.members.find((m) => m.organizationId === organizationId && m.id === memberId);
  }
  async findMemberByUser(organizationId: string, userId: string) {
    return this.members.find((m) => m.organizationId === organizationId && m.userId === userId);
  }
  async findMemberByEmail(organizationId: string, email: string) {
    return this.members.find((m) => m.organizationId === organizationId && m.email === email);
  }
  async countOwners(organizationId: string) {
    return this.members.filter((m) => m.organizationId === organizationId && m.role === 'owner').length;
  }
  async setRole(memberId: string, role: Role) {
    this.members = this.members.map((m) => (m.id === memberId ? { ...m, role } : m));
  }
  async removeMember(memberId: string) {
    this.members = this.members.filter((m) => m.id !== memberId);
  }
  async listPendingInvitations(organizationId: string) {
    return this.invitations.filter((i) => i.organizationId === organizationId && i.status === 'pending');
  }
  async findInvitation(organizationId: string, invitationId: string) {
    return this.invitations.find((i) => i.organizationId === organizationId && i.id === invitationId);
  }
  async findPendingInvitationByEmail(organizationId: string, email: string) {
    return this.invitations.find(
      (i) => i.organizationId === organizationId && i.email === email && i.status === 'pending',
    );
  }
  async createInvitation(input: {
    organizationId: string;
    email: string;
    role: Role;
    inviterId: string;
    expiresAt: Date;
  }) {
    const invitation: InvitationRecord = {
      ...input,
      id: uuid(),
      status: 'pending',
      inviterName: this.users.get(input.inviterId)?.name ?? '?',
      createdAt: new Date('2026-10-14T12:00:00Z'),
    };
    this.invitations.push(invitation);
    return invitation;
  }
  async updateInvitation(
    invitationId: string,
    patch: { status?: InvitationRecord['status']; expiresAt?: Date },
  ) {
    this.invitations = this.invitations.map((i) => (i.id === invitationId ? { ...i, ...patch } : i));
  }
}

export class InMemoryApiKeys implements ApiKeyRepository, ApiKeyIssuer {
  keys: ApiKeyRecord[] = [];

  async issue(input: Parameters<ApiKeyIssuer['issue']>[0]) {
    const id = uuid();
    this.keys.push({
      id,
      organizationId: input.organizationId,
      name: input.name,
      start: 'bf_test',
      permissions: [...input.permissions],
      createdBy: input.createdBy,
      createdAt: new Date('2026-10-14T12:00:00Z'),
      lastUsedAt: null,
      expiresAt: input.expiresInSeconds
        ? new Date(Date.parse('2026-10-14T12:00:00Z') + input.expiresInSeconds * 1000)
        : null,
      revokedAt: null,
    });
    return { id, key: `bf_secret_${id}` };
  }
  async list(organizationId: string) {
    return this.keys.filter((k) => k.organizationId === organizationId);
  }
  async find(organizationId: string, apiKeyId: string) {
    return this.keys.find((k) => k.organizationId === organizationId && k.id === apiKeyId);
  }
  async revoke(apiKeyId: string, at: Date) {
    this.keys = this.keys.map((k) => (k.id === apiKeyId ? { ...k, revokedAt: at } : k));
  }
}

export class RecordingEvents implements IdentityEvents {
  events: IdentityEvent[] = [];
  async publish(event: IdentityEvent) {
    this.events.push(event);
  }
}

export class RecordingMailer implements SystemMailer {
  invitations: Parameters<SystemMailer['sendInvitation']>[0][] = [];
  async sendInvitation(input: Parameters<SystemMailer['sendInvitation']>[0]) {
    this.invitations.push(input);
  }
  async sendVerificationEmail() {}
  async sendPasswordReset() {}
  async sendTwoFactorEnabled() {}
}
