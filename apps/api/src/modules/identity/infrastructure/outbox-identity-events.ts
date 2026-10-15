import {
  ApiKeyCreated,
  ApiKeyRevoked,
  InvitationResent,
  InvitationRevoked,
  MemberInvited,
  MemberRemoved,
  MemberRoleChanged,
  UserSignedUp,
} from '@bf/contracts';
import { Injectable } from '@nestjs/common';
import { EventRecorder } from '../../platform/events/event-recorder.ts';
import type { IdentityEvent, IdentityEvents } from '../application/ports.ts';

/**
 * Identity events go to the transactional outbox (BF-012): recorded in the publishing use case's transaction when
 * it has one, then delivered to subscribers (the audit log, notifications…).
 */
@Injectable()
export class OutboxIdentityEvents implements IdentityEvents {
  constructor(private readonly events: EventRecorder) {}

  async publish(event: IdentityEvent, actor: { readonly userId: string | null }): Promise<void> {
    const by = actor.userId ? { actor: { type: 'user' as const, id: actor.userId } } : {};
    switch (event.type) {
      case 'identity.user_signed_up':
        await this.events.record(UserSignedUp, { payload: { userId: event.userId }, orgId: null, ...by });
        return;
      case 'identity.member_invited':
        await this.events.record(MemberInvited, {
          payload: { invitationId: event.invitationId, role: event.role },
          orgId: event.organizationId,
          ...by,
        });
        return;
      case 'identity.invitation_resent':
      case 'identity.invitation_revoked':
        await this.events.record(
          event.type === 'identity.invitation_resent' ? InvitationResent : InvitationRevoked,
          {
            payload: { invitationId: event.invitationId },
            orgId: event.organizationId,
            ...by,
          },
        );
        return;
      case 'identity.member_role_changed':
        await this.events.record(MemberRoleChanged, {
          payload: { memberId: event.memberId, from: event.from, to: event.to },
          orgId: event.organizationId,
          ...by,
        });
        return;
      case 'identity.member_removed':
        await this.events.record(MemberRemoved, {
          payload: { memberId: event.memberId, userId: event.userId },
          orgId: event.organizationId,
          ...by,
        });
        return;
      case 'identity.api_key_created':
      case 'identity.api_key_revoked':
        await this.events.record(event.type === 'identity.api_key_created' ? ApiKeyCreated : ApiKeyRevoked, {
          payload: { apiKeyId: event.apiKeyId },
          orgId: event.organizationId,
          ...by,
        });
        return;
    }
  }
}
