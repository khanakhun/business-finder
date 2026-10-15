import { type Me, NotFoundError } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { sessionUserId } from './actor.ts';
import { MEMBERSHIP_REPOSITORY, type MembershipRepository } from './ports.ts';

/** `GET /v1/me`: the caller, their workspaces, and their role/permissions in the active one. */
@Injectable()
export class GetMeQuery {
  constructor(@Inject(MEMBERSHIP_REPOSITORY) private readonly members: MembershipRepository) {}

  async execute(auth: AuthContext): Promise<Me> {
    const userId = sessionUserId(auth);
    const [user, organizations] = await Promise.all([
      this.members.findUser(userId),
      this.members.organizationsOf(userId),
    ]);
    if (!user) throw new NotFoundError('User', userId);
    const active = organizations.find((o) => o.id === auth.orgId) ?? null;
    return {
      user,
      activeOrganization: active,
      role: active ? active.role : null,
      permissions: active ? [...auth.permissions].sort() : [],
      organizations,
    };
  }
}
