import { type Locale, type Role, RoleSchema } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { invitation, member, organization, user } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type {
  InvitationRecord,
  MemberRecord,
  MembershipRepository,
  OrganizationRecord,
  UserRecord,
} from '../application/ports.ts';

// Roles are stored as text by Better Auth; anything unexpected degrades to the least privilege.
const asRole = (value: string | null): Role => RoleSchema.catch('viewer').parse(value);
const asLocale = (value: string | null): Locale => (value === 'fr' ? 'fr' : 'en');

const memberColumns = {
  id: member.id,
  organizationId: member.organizationId,
  userId: member.userId,
  role: member.role,
  createdAt: member.createdAt,
  name: user.name,
  email: user.email,
  image: user.image,
};

const inviter = alias(user, 'inviter');
const invitationColumns = {
  id: invitation.id,
  organizationId: invitation.organizationId,
  email: invitation.email,
  role: invitation.role,
  status: invitation.status,
  expiresAt: invitation.expiresAt,
  inviterId: invitation.inviterId,
  inviterName: inviter.name,
  createdAt: invitation.createdAt,
};

type MemberRow = Omit<MemberRecord, 'role'> & { readonly role: string };
type InvitationRow = Omit<InvitationRecord, 'role' | 'status'> & {
  readonly role: string | null;
  readonly status: string;
};

const toMember = (row: MemberRow): MemberRecord => ({ ...row, role: asRole(row.role) });
const toInvitation = (row: InvitationRow): InvitationRecord => ({
  ...row,
  role: asRole(row.role),
  status: row.status as InvitationRecord['status'],
});

/** Membership data on Better Auth's tables. Every org-scoped lookup filters by organization_id. */
@Injectable()
export class DrizzleMembershipRepository implements MembershipRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private get q() {
    return getExecutor(this.db);
  }

  async findUser(userId: string): Promise<UserRecord | undefined> {
    const [row] = await this.q.select().from(user).where(eq(user.id, userId));
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      emailVerified: row.emailVerified,
      image: row.image,
      locale: asLocale(row.locale),
      twoFactorEnabled: row.twoFactorEnabled ?? false,
    };
  }

  async findOrganization(organizationId: string): Promise<OrganizationRecord | undefined> {
    const [row] = await this.q
      .select({ id: organization.id, name: organization.name, slug: organization.slug })
      .from(organization)
      .where(eq(organization.id, organizationId));
    return row;
  }

  async organizationsOf(userId: string) {
    const rows = await this.q
      .select({ id: organization.id, name: organization.name, slug: organization.slug, role: member.role })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(eq(member.userId, userId))
      .orderBy(asc(organization.name));
    return rows.map((row) => ({ ...row, role: asRole(row.role) }));
  }

  async roleOf(userId: string, organizationId: string): Promise<Role | undefined> {
    const [row] = await this.q
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, organizationId)));
    return row ? asRole(row.role) : undefined;
  }

  async listMembers(organizationId: string): Promise<MemberRecord[]> {
    const rows = await this.q
      .select(memberColumns)
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, organizationId))
      .orderBy(asc(member.createdAt));
    return rows.map(toMember);
  }

  private async memberWhere(condition: ReturnType<typeof and>): Promise<MemberRecord | undefined> {
    const [row] = await this.q
      .select(memberColumns)
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(condition);
    return row ? toMember(row) : undefined;
  }

  findMember(organizationId: string, memberId: string) {
    return this.memberWhere(and(eq(member.organizationId, organizationId), eq(member.id, memberId)));
  }

  findMemberByUser(organizationId: string, userId: string) {
    return this.memberWhere(and(eq(member.organizationId, organizationId), eq(member.userId, userId)));
  }

  findMemberByEmail(organizationId: string, email: string) {
    return this.memberWhere(
      and(eq(member.organizationId, organizationId), eq(user.email, email.toLowerCase())),
    );
  }

  async countOwners(organizationId: string): Promise<number> {
    // FOR UPDATE: inside a transaction this serializes concurrent owner changes (last-owner rule).
    const rows = await this.q
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.organizationId, organizationId), eq(member.role, 'owner')))
      .for('update');
    return rows.length;
  }

  async setRole(memberId: string, role: Role): Promise<void> {
    await this.q.update(member).set({ role }).where(eq(member.id, memberId));
  }

  async removeMember(memberId: string): Promise<void> {
    await this.q.delete(member).where(eq(member.id, memberId));
  }

  private invitationsWhere(condition: ReturnType<typeof and>) {
    return this.q
      .select(invitationColumns)
      .from(invitation)
      .innerJoin(inviter, eq(inviter.id, invitation.inviterId))
      .where(condition);
  }

  async listPendingInvitations(organizationId: string): Promise<InvitationRecord[]> {
    const rows = await this.invitationsWhere(
      and(eq(invitation.organizationId, organizationId), eq(invitation.status, 'pending')),
    ).orderBy(asc(invitation.createdAt));
    return rows.map(toInvitation);
  }

  async findInvitation(organizationId: string, invitationId: string): Promise<InvitationRecord | undefined> {
    const [row] = await this.invitationsWhere(
      and(eq(invitation.organizationId, organizationId), eq(invitation.id, invitationId)),
    );
    return row ? toInvitation(row) : undefined;
  }

  async findPendingInvitationByEmail(
    organizationId: string,
    email: string,
  ): Promise<InvitationRecord | undefined> {
    const [row] = await this.invitationsWhere(
      and(
        eq(invitation.organizationId, organizationId),
        eq(invitation.email, email.toLowerCase()),
        eq(invitation.status, 'pending'),
      ),
    );
    return row ? toInvitation(row) : undefined;
  }

  async createInvitation(input: {
    organizationId: string;
    email: string;
    role: Role;
    inviterId: string;
    expiresAt: Date;
  }): Promise<InvitationRecord> {
    const [created] = await this.q
      .insert(invitation)
      .values({ ...input, email: input.email.toLowerCase(), status: 'pending' })
      .returning({ id: invitation.id });
    const record = created && (await this.findInvitation(input.organizationId, created.id));
    if (!record) throw new Error('invitation insert returned nothing');
    return record;
  }

  async updateInvitation(
    invitationId: string,
    patch: { status?: InvitationRecord['status']; expiresAt?: Date },
  ): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    await this.q.update(invitation).set(patch).where(eq(invitation.id, invitationId));
  }
}
