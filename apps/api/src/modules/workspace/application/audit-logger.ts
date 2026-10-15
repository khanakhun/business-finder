import { AuditActionSchema, type AuditActorType, type Clock } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { getRequestContext } from '../../platform/context/request-context.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { redactMetadata } from '../domain/audit-redaction.ts';
import { AUDIT_LOG_REPOSITORY, type AuditLogRepository } from './ports.ts';

export interface AuditActor {
  readonly type: AuditActorType;
  readonly id: string | null;
}

export interface AuditEntryInput {
  /** Dotted lower-case, e.g. `secrets.updated`. */
  readonly action: string;
  /** Defaults to the caller's workspace; `null` for platform events. */
  readonly organizationId?: string | null;
  readonly entityType?: string;
  readonly entityId?: string;
  /** Never secret values: sensitive keys are redacted anyway. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** The caller; defaults to the request's (user or API key), else `system`. */
  readonly auth?: AuthContext;
  /** Overrides `auth` (e.g. a user acting through a Better Auth hook). */
  readonly actor?: AuditActor;
}

export function actorOf(auth: AuthContext | undefined): AuditActor {
  if (auth?.method === 'api_key') return { type: 'api_key', id: auth.apiKeyId };
  if (auth?.userId) return { type: 'user', id: auth.userId };
  return { type: 'system', id: null };
}

/**
 * Records security-relevant and outbound actions in the append-only audit log (BF-011). Inside a use case it joins
 * the ambient transaction, so the entry commits (or rolls back) with the change it describes.
 */
@Injectable()
export class AuditLogger {
  constructor(
    @Inject(AUDIT_LOG_REPOSITORY) private readonly repository: AuditLogRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async record(entry: AuditEntryInput): Promise<void> {
    // A malformed action is a programming error: fail loudly in tests rather than store junk.
    AuditActionSchema.parse(entry.action);
    const context = getRequestContext();
    const auth = entry.auth ?? context?.auth;
    const actor = entry.actor ?? actorOf(auth);
    await this.repository.insert({
      organizationId: entry.organizationId === undefined ? (auth?.orgId ?? null) : entry.organizationId,
      actorType: actor.type,
      actorId: actor.id,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      ip: context?.ip ?? null,
      userAgent: context?.userAgent ?? null,
      metadata: redactMetadata(entry.metadata ?? {}),
      occurredAt: this.clock.now(),
    });
  }
}
