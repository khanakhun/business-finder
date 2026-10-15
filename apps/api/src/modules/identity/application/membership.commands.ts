import { type Member, NotFoundError, type Role } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { Transactional } from '../../platform/db/transactional.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { assertCanChangeRole, assertCanRemove, planOwnershipTransfer } from '../domain/membership-policy.ts';
import { type MemberActor, memberActor } from './actor.ts';
import { toMember } from './mappers.ts';
import {
  IDENTITY_EVENTS,
  type IdentityEvents,
  MEMBERSHIP_REPOSITORY,
  type MemberRecord,
  type MembershipRepository,
} from './ports.ts';

/** Loads the acting member and the target, both scoped to the actor's workspace (other workspaces → 404). */
async function loadPair(
  members: MembershipRepository,
  actor: MemberActor,
  memberId: string,
): Promise<{ self: MemberRecord; target: MemberRecord }> {
  const [self, target] = await Promise.all([
    members.findMemberByUser(actor.orgId, actor.userId),
    members.findMember(actor.orgId, memberId),
  ]);
  if (!target) throw new NotFoundError('Member', memberId);
  if (!self) throw new NotFoundError('Member', actor.userId);
  return { self, target };
}

const facts = (m: MemberRecord) => ({ memberId: m.id, role: m.role });

@Injectable()
export class ChangeMemberRoleCommand {
  constructor(
    @Inject(MEMBERSHIP_REPOSITORY) private readonly members: MembershipRepository,
    @Inject(IDENTITY_EVENTS) private readonly events: IdentityEvents,
  ) {}

  async execute(auth: AuthContext, memberId: string, role: Role): Promise<Member> {
    const actor = memberActor(auth);
    const { before, after } = await this.change(actor, memberId, role);
    if (before.role !== after.role) {
      await this.events.publish(
        {
          type: 'identity.member_role_changed',
          organizationId: actor.orgId,
          memberId,
          from: before.role,
          to: after.role,
        },
        { userId: actor.userId },
      );
    }
    return toMember(after);
  }

  @Transactional()
  private async change(actor: MemberActor, memberId: string, role: Role) {
    const { self, target } = await loadPair(this.members, actor, memberId);
    // countOwners locks the owner rows, so two concurrent demotions cannot both pass the last-owner check.
    assertCanChangeRole(facts(self), facts(target), role, await this.members.countOwners(actor.orgId));
    if (target.role !== role) await this.members.setRole(target.id, role);
    return { before: target, after: { ...target, role } };
  }
}

@Injectable()
export class RemoveMemberCommand {
  constructor(
    @Inject(MEMBERSHIP_REPOSITORY) private readonly members: MembershipRepository,
    @Inject(IDENTITY_EVENTS) private readonly events: IdentityEvents,
  ) {}

  async execute(auth: AuthContext, memberId: string): Promise<void> {
    const actor = memberActor(auth);
    const removed = await this.remove(actor, memberId);
    await this.events.publish(
      { type: 'identity.member_removed', organizationId: actor.orgId, memberId, userId: removed.userId },
      { userId: actor.userId },
    );
  }

  @Transactional()
  private async remove(actor: MemberActor, memberId: string): Promise<MemberRecord> {
    const { self, target } = await loadPair(this.members, actor, memberId);
    assertCanRemove(facts(self), facts(target), await this.members.countOwners(actor.orgId));
    await this.members.removeMember(target.id);
    return target;
  }
}

@Injectable()
export class TransferOwnershipCommand {
  constructor(
    @Inject(MEMBERSHIP_REPOSITORY) private readonly members: MembershipRepository,
    @Inject(IDENTITY_EVENTS) private readonly events: IdentityEvents,
  ) {}

  async execute(auth: AuthContext, memberId: string): Promise<void> {
    const actor = memberActor(auth);
    const { previousOwner, newOwner } = await this.transfer(actor, memberId);
    for (const [member, from, to] of [
      [newOwner, newOwner.role, 'owner'],
      [previousOwner, 'owner', 'admin'],
    ] as const) {
      await this.events.publish(
        { type: 'identity.member_role_changed', organizationId: actor.orgId, memberId: member.id, from, to },
        { userId: actor.userId },
      );
    }
  }

  @Transactional()
  private async transfer(actor: MemberActor, memberId: string) {
    const { self, target } = await loadPair(this.members, actor, memberId);
    await this.members.countOwners(actor.orgId); // lock owner rows for the swap
    const plan = planOwnershipTransfer(facts(self), facts(target));
    await this.members.setRole(plan.promote, 'owner');
    await this.members.setRole(plan.demote, 'admin');
    return { previousOwner: self, newOwner: target };
  }
}
