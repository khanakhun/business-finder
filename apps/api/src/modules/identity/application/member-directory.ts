import type { Locale } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { MEMBERSHIP_REPOSITORY, type MembershipRepository } from './ports.ts';

export interface MemberContact {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly locale: Locale;
}

/** Read-only member lookups for other modules (notifications), so they never read identity tables themselves. */
@Injectable()
export class MemberDirectory {
  constructor(@Inject(MEMBERSHIP_REPOSITORY) private readonly members: MembershipRepository) {}

  /** User ids of a workspace's members. */
  async memberIds(organizationId: string): Promise<string[]> {
    return (await this.members.listMembers(organizationId)).map((member) => member.userId);
  }

  /** Owners and admins of a workspace (who receive operational digests and alerts). */
  async ownerIds(organizationId: string): Promise<string[]> {
    return (await this.members.listMembers(organizationId))
      .filter((member) => member.role === 'owner' || member.role === 'admin')
      .map((member) => member.userId);
  }

  async isMember(organizationId: string, userId: string): Promise<boolean> {
    return (await this.members.roleOf(userId, organizationId)) !== undefined;
  }

  async contact(userId: string): Promise<MemberContact | undefined> {
    const user = await this.members.findUser(userId);
    return user ? { userId: user.id, name: user.name, email: user.email, locale: user.locale } : undefined;
  }
}
