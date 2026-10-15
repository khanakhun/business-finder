import {
  type Clock,
  ConflictError,
  type Invitation,
  type InviteMemberRequest,
  NotFoundError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { assertCanInvite } from '../domain/membership-policy.ts';
import { memberActor } from './actor.ts';
import { toInvitation } from './mappers.ts';
import {
  APP_URL,
  IDENTITY_EVENTS,
  type IdentityEvents,
  type InvitationRecord,
  MEMBERSHIP_REPOSITORY,
  type MembershipRepository,
  SYSTEM_MAILER,
  type SystemMailer,
} from './ports.ts';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Builds the accept link and sends the invitation email (shared by invite and resend). */
@Injectable()
export class InvitationMailer {
  constructor(
    @Inject(MEMBERSHIP_REPOSITORY) private readonly members: MembershipRepository,
    @Inject(SYSTEM_MAILER) private readonly mailer: SystemMailer,
  ) {}

  async send(invitation: InvitationRecord, appUrl: string): Promise<void> {
    const [org, inviter] = await Promise.all([
      this.members.findOrganization(invitation.organizationId),
      this.members.findUser(invitation.inviterId),
    ]);
    await this.mailer.sendInvitation({
      to: invitation.email,
      inviterName: inviter?.name ?? 'A teammate',
      organizationName: org?.name ?? 'Business Finder',
      role: invitation.role,
      url: `${appUrl}/invite/${invitation.id}`,
      locale: inviter?.locale ?? 'en',
    });
  }
}

/** Invite someone by email. Re-inviting the same address replaces the pending invitation. */
@Injectable()
export class InviteMemberCommand {
  constructor(
    @Inject(MEMBERSHIP_REPOSITORY) private readonly members: MembershipRepository,
    @Inject(IDENTITY_EVENTS) private readonly events: IdentityEvents,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_URL) private readonly appUrl: string,
    private readonly invitationMailer: InvitationMailer,
  ) {}

  async execute(auth: AuthContext, input: InviteMemberRequest): Promise<Invitation> {
    const actor = memberActor(auth);
    assertCanInvite(actor.role, input.role);
    const invitation = await this.create(actor.orgId, actor.userId, input);
    // After the commit: a failed email leaves a valid invitation that can be re-sent.
    await this.invitationMailer.send(invitation, this.appUrl);
    await this.events.publish(
      {
        type: 'identity.member_invited',
        organizationId: actor.orgId,
        invitationId: invitation.id,
        role: input.role,
      },
      { userId: actor.userId },
    );
    return toInvitation(invitation);
  }

  @Transactional()
  private async create(
    orgId: string,
    inviterId: string,
    input: InviteMemberRequest,
  ): Promise<InvitationRecord> {
    if (await this.members.findMemberByEmail(orgId, input.email)) {
      throw new ConflictError(`${input.email} is already a member of this workspace.`, {
        details: { reason: 'ALREADY_MEMBER' },
      });
    }
    const previous = await this.members.findPendingInvitationByEmail(orgId, input.email);
    if (previous) await this.members.updateInvitation(previous.id, { status: 'canceled' });
    return this.members.createInvitation({
      organizationId: orgId,
      email: input.email,
      role: input.role,
      inviterId,
      expiresAt: new Date(this.clock.now().getTime() + INVITATION_TTL_MS),
    });
  }
}

/** Send the invitation again with a fresh expiry. */
@Injectable()
export class ResendInvitationCommand {
  constructor(
    @Inject(MEMBERSHIP_REPOSITORY) private readonly members: MembershipRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_URL) private readonly appUrl: string,
    private readonly invitationMailer: InvitationMailer,
    @Inject(IDENTITY_EVENTS) private readonly events: IdentityEvents,
  ) {}

  async execute(auth: AuthContext, invitationId: string): Promise<Invitation> {
    const actor = memberActor(auth);
    const invitation = await pendingInvitation(this.members, actor.orgId, invitationId);
    assertCanInvite(actor.role, invitation.role);
    const expiresAt = new Date(this.clock.now().getTime() + INVITATION_TTL_MS);
    await this.members.updateInvitation(invitation.id, { expiresAt });
    const refreshed = { ...invitation, expiresAt };
    await this.invitationMailer.send(refreshed, this.appUrl);
    await this.events.publish(
      { type: 'identity.invitation_resent', organizationId: actor.orgId, invitationId: invitation.id },
      { userId: actor.userId },
    );
    return toInvitation(refreshed);
  }
}

/** Withdraw a pending invitation; its link stops working. */
@Injectable()
export class RevokeInvitationCommand {
  constructor(
    @Inject(MEMBERSHIP_REPOSITORY) private readonly members: MembershipRepository,
    @Inject(IDENTITY_EVENTS) private readonly events: IdentityEvents,
  ) {}

  @Transactional()
  async execute(auth: AuthContext, invitationId: string): Promise<void> {
    const actor = memberActor(auth);
    const invitation = await pendingInvitation(this.members, actor.orgId, invitationId);
    assertCanInvite(actor.role, invitation.role);
    await this.members.updateInvitation(invitation.id, { status: 'canceled' });
    await this.events.publish(
      { type: 'identity.invitation_revoked', organizationId: actor.orgId, invitationId: invitation.id },
      { userId: actor.userId },
    );
  }
}

async function pendingInvitation(
  members: MembershipRepository,
  orgId: string,
  invitationId: string,
): Promise<InvitationRecord> {
  const invitation = await members.findInvitation(orgId, invitationId);
  if (invitation?.status !== 'pending') throw new NotFoundError('Invitation', invitationId);
  return invitation;
}
