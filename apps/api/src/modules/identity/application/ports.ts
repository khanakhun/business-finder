import type { AuthMailer } from '@bf/auth';
import type { Locale, Permission, Role } from '@bf/contracts';

export interface UserRecord {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly image: string | null;
  readonly locale: Locale;
  readonly twoFactorEnabled: boolean;
}

export interface MemberRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: Role;
  readonly name: string;
  readonly email: string;
  readonly image: string | null;
  readonly createdAt: Date;
}

export interface InvitationRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly role: Role;
  readonly status: 'pending' | 'accepted' | 'rejected' | 'canceled';
  readonly expiresAt: Date;
  readonly inviterId: string;
  readonly inviterName: string;
  readonly createdAt: Date;
}

export interface OrganizationRecord {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

/** Port: users, workspaces, memberships and invitations (Better Auth's tables, owned by this module). */
export interface MembershipRepository {
  findUser(userId: string): Promise<UserRecord | undefined>;
  findOrganization(organizationId: string): Promise<OrganizationRecord | undefined>;
  /** Workspaces the user belongs to, with their role, by name. */
  organizationsOf(userId: string): Promise<(OrganizationRecord & { readonly role: Role })[]>;
  roleOf(userId: string, organizationId: string): Promise<Role | undefined>;
  listMembers(organizationId: string): Promise<MemberRecord[]>;
  /** Scoped by organization: a membership of another workspace is not found. */
  findMember(organizationId: string, memberId: string): Promise<MemberRecord | undefined>;
  findMemberByUser(organizationId: string, userId: string): Promise<MemberRecord | undefined>;
  findMemberByEmail(organizationId: string, email: string): Promise<MemberRecord | undefined>;
  countOwners(organizationId: string): Promise<number>;
  setRole(memberId: string, role: Role): Promise<void>;
  removeMember(memberId: string): Promise<void>;
  listPendingInvitations(organizationId: string): Promise<InvitationRecord[]>;
  findInvitation(organizationId: string, invitationId: string): Promise<InvitationRecord | undefined>;
  findPendingInvitationByEmail(organizationId: string, email: string): Promise<InvitationRecord | undefined>;
  createInvitation(input: {
    readonly organizationId: string;
    readonly email: string;
    readonly role: Role;
    readonly inviterId: string;
    readonly expiresAt: Date;
  }): Promise<InvitationRecord>;
  updateInvitation(
    invitationId: string,
    patch: { readonly status?: InvitationRecord['status']; readonly expiresAt?: Date },
  ): Promise<void>;
}
export const MEMBERSHIP_REPOSITORY = Symbol('MembershipRepository');

export interface ApiKeyRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly start: string | null;
  readonly permissions: Permission[];
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

/** Port: listing and revoking organization API keys. */
export interface ApiKeyRepository {
  list(organizationId: string): Promise<ApiKeyRecord[]>;
  find(organizationId: string, apiKeyId: string): Promise<ApiKeyRecord | undefined>;
  /** Disables the key (verification fails from now on) and records when; the row stays for the audit trail. */
  revoke(apiKeyId: string, at: Date): Promise<void>;
}
export const API_KEY_REPOSITORY = Symbol('ApiKeyRepository');

/** Port: mints keys (hashing and storage belong to Better Auth's api-key plugin). */
export interface ApiKeyIssuer {
  issue(input: {
    readonly organizationId: string;
    readonly createdBy: string;
    readonly name: string;
    readonly permissions: readonly Permission[];
    readonly expiresInSeconds: number | null;
  }): Promise<{ readonly id: string; readonly key: string }>;
}
export const API_KEY_ISSUER = Symbol('ApiKeyIssuer');

/** A notification email (BF-012): already translated; `url` is absolute. */
export interface NotificationEmail {
  readonly to: string;
  readonly locale: Locale;
  readonly title: string;
  readonly body: string | null;
  readonly url: string | null;
}

/** Port: system emails (verification, reset, invitation, 2FA notice, notifications). */
export type SystemMailer = AuthMailer & {
  sendNotification(input: NotificationEmail): Promise<void>;
};
export const SYSTEM_MAILER = Symbol('SystemMailer');

export type IdentityEvent =
  | { readonly type: 'identity.user_signed_up'; readonly userId: string }
  | {
      readonly type: 'identity.member_invited';
      readonly organizationId: string;
      readonly invitationId: string;
      readonly role: Role;
    }
  | {
      readonly type: 'identity.member_joined';
      readonly organizationId: string;
      readonly memberId: string;
      readonly userId: string;
      readonly role: Role;
    }
  | {
      readonly type: 'identity.member_role_changed';
      readonly organizationId: string;
      readonly memberId: string;
      readonly from: Role;
      readonly to: Role;
    }
  | {
      readonly type: 'identity.member_removed';
      readonly organizationId: string;
      readonly memberId: string;
      readonly userId: string;
    }
  | {
      readonly type: 'identity.invitation_resent' | 'identity.invitation_revoked';
      readonly organizationId: string;
      readonly invitationId: string;
    }
  | { readonly type: 'identity.api_key_created'; readonly organizationId: string; readonly apiKeyId: string }
  | { readonly type: 'identity.api_key_revoked'; readonly organizationId: string; readonly apiKeyId: string };

/** Port: identity domain events, recorded in the transactional outbox (BF-012) and audited by a subscriber. */
export interface IdentityEvents {
  publish(event: IdentityEvent, actor: { readonly userId: string | null }): Promise<void>;
}
export const IDENTITY_EVENTS = Symbol('IdentityEvents');

/** Public URL of the dashboard, for links in emails. */
export const APP_URL = Symbol('APP_URL');
