import type { MembersOverview } from '@bf/contracts';
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
