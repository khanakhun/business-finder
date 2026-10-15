import type { MembersOverview, TeammateList } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { toInvitation, toMember } from './mappers.ts';
import { MEMBERSHIP_REPOSITORY, type MembershipRepository } from './ports.ts';

/** Members of the caller's active workspace and its pending invitations. */
@Injectable()
export class ListMembersQuery {
  constructor(@Inject(MEMBERSHIP_REPOSITORY) private readonly members: MembershipRepository) {}

  async execute(auth: AuthContext & { readonly orgId: string }): Promise<MembersOverview> {
    const [members, invitations] = await Promise.all([
      this.members.listMembers(auth.orgId),
      this.members.listPendingInvitations(auth.orgId),
    ]);
    return { members: members.map(toMember), invitations: invitations.map(toInvitation) };
  }
}

/** The workspace's members by name, for anyone who works its businesses (BF-024 owner and assignee pickers). */
@Injectable()
export class ListTeammatesQuery {
  constructor(@Inject(MEMBERSHIP_REPOSITORY) private readonly members: MembershipRepository) {}

  async execute(auth: AuthContext & { readonly orgId: string }): Promise<TeammateList> {
    const members = await this.members.listMembers(auth.orgId);
    return {
      items: members
        .map(({ userId, name, image }) => ({ userId, name, image }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
}
