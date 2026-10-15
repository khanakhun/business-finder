import { type DomainEvent, IDENTITY_EVENTS } from '@bf/contracts';
import { Injectable } from '@nestjs/common';
import { type DeliveryMeta, OnDomainEvent } from '../../platform/events/on-domain-event.decorator.ts';
import { type AuditActor, AuditLogger } from './audit-logger.ts';

type IdentityEvent = DomainEvent<(typeof IDENTITY_EVENTS)[number]>;

/** Where each identity event lands in the audit log: the entity it concerns, and what is safe to keep. */
function target(event: IdentityEvent): {
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
} {
  switch (event.type) {
    case 'identity.user_signed_up':
      return { entityType: 'user', entityId: event.payload.userId, metadata: {} };
    case 'identity.member_invited':
      return {
        entityType: 'invitation',
        entityId: event.payload.invitationId,
        metadata: { role: event.payload.role },
      };
    case 'identity.invitation_resent':
    case 'identity.invitation_revoked':
      return { entityType: 'invitation', entityId: event.payload.invitationId, metadata: {} };
    case 'identity.member_role_changed':
      return {
        entityType: 'member',
        entityId: event.payload.memberId,
        metadata: { from: event.payload.from, to: event.payload.to },
      };
    case 'identity.member_removed':
      return {
        entityType: 'member',
        entityId: event.payload.memberId,
        metadata: { userId: event.payload.userId },
      };
    case 'identity.api_key_created':
    case 'identity.api_key_revoked':
      return { entityType: 'api_key', entityId: event.payload.apiKeyId, metadata: {} };
  }
}

const actorOf = (event: IdentityEvent): AuditActor =>
  event.actor.type === 'user' || event.actor.type === 'api_key'
    ? { type: event.actor.type, id: event.actor.id }
    : { type: 'system', id: event.actor.id };

/**
 * Identity events → audit log (BF-011 + BF-012), delivered through the outbox. The audit entry takes the event's
 * id, so a redelivered event writes nothing new.
 */
@Injectable()
export class IdentityAuditSubscriber {
  constructor(private readonly audit: AuditLogger) {}

  @OnDomainEvent(IDENTITY_EVENTS, { id: 'workspace.audit-identity' })
  async record(event: IdentityEvent, meta: DeliveryMeta): Promise<void> {
    await this.audit.record({
      action: event.type,
      organizationId: event.orgId,
      actor: actorOf(event),
      ...target(event),
      fromEvent: {
        id: event.id,
        occurredAt: new Date(event.occurredAt),
        ip: meta.context.ip,
        userAgent: meta.context.userAgent,
      },
    });
  }
}
