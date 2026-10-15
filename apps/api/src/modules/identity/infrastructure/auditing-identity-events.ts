import type { Logger } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { LOGGER } from '../../platform/logging/logger.ts';
import { AuditLogger } from '../../workspace/index.ts';
import type { IdentityEvent, IdentityEvents } from '../application/ports.ts';

/** Where each event lands in the audit log: the entity it concerns, and what is safe to keep (no emails). */
function auditEntry(event: IdentityEvent): {
  organizationId: string | null;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
} {
  switch (event.type) {
    case 'identity.user_signed_up':
      return { organizationId: null, entityType: 'user', entityId: event.userId, metadata: {} };
    case 'identity.member_invited':
      return {
        organizationId: event.organizationId,
        entityType: 'invitation',
        entityId: event.invitationId,
        metadata: { role: event.role },
      };
    case 'identity.invitation_resent':
    case 'identity.invitation_revoked':
      return {
        organizationId: event.organizationId,
        entityType: 'invitation',
        entityId: event.invitationId,
        metadata: {},
      };
    case 'identity.member_role_changed':
      return {
        organizationId: event.organizationId,
        entityType: 'member',
        entityId: event.memberId,
        metadata: { from: event.from, to: event.to },
      };
    case 'identity.member_removed':
      return {
        organizationId: event.organizationId,
        entityType: 'member',
        entityId: event.memberId,
        metadata: { userId: event.userId },
      };
    case 'identity.api_key_created':
    case 'identity.api_key_revoked':
      return {
        organizationId: event.organizationId,
        entityType: 'api_key',
        entityId: event.apiKeyId,
        metadata: {},
      };
  }
}

/**
 * Identity events go to the audit log (BF-011), inside the publishing use case's transaction when it has one.
 * TODO(BF-012): also publish through the transactional outbox.
 */
@Injectable()
export class AuditingIdentityEvents implements IdentityEvents {
  constructor(
    private readonly audit: AuditLogger,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async publish(event: IdentityEvent, actor: { readonly userId: string | null }): Promise<void> {
    this.logger.info({ event, actorUserId: actor.userId }, event.type);
    const entry = auditEntry(event);
    await this.audit.record({
      action: event.type,
      ...entry,
      // Session-initiated events name their user; Better Auth hooks run outside our request context.
      ...(actor.userId ? { actor: { type: 'user', id: actor.userId } } : {}),
    });
  }
}
