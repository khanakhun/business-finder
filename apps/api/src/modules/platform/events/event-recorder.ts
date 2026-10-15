import { type Actor, type Clock, type DomainEvent, newId } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { injectTraceContext } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import { CLOCK } from '../clock/clock.module.ts';
import { getRequestContext } from '../context/request-context.ts';
import { DB_CLIENT } from '../db/db.module.ts';
import { getEventContext } from './event-context.ts';
import type { AnyEventDefinition } from './on-domain-event.decorator.ts';
import { OutboxRepository } from './outbox.repository.ts';

export const OUTBOX_CHANNEL = 'bf_outbox';

export interface RecordInput<D extends AnyEventDefinition> {
  readonly payload: z.input<D['schema']>['payload'];
  /** Defaults to the caller's workspace; `null` for platform events. */
  readonly orgId?: string | null;
  /** Defaults to the request's caller (user or API key), the handling subscriber, else the system. */
  readonly actor?: Actor;
}

/**
 * Records domain events in the transactional outbox (ARCHITECTURE §7.2). Call it inside the use case's
 * transaction: the event exists only if the transaction commits. `NOTIFY` is transactional too, so relays wake up
 * on commit and never for rolled-back work.
 */
@Injectable()
export class EventRecorder {
  constructor(
    private readonly outbox: OutboxRepository,
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async record<D extends AnyEventDefinition>(definition: D, input: RecordInput<D>): Promise<DomainEvent<D>> {
    const request = getRequestContext();
    const handling = getEventContext();
    const auth = request?.auth;
    const actor: Actor =
      input.actor ??
      (auth?.method === 'api_key'
        ? { type: 'api_key', id: auth.apiKeyId }
        : auth?.userId
          ? { type: 'user', id: auth.userId }
          : handling
            ? { type: 'system', id: handling.subscriberId }
            : { type: 'system', id: null });
    const event = definition.create({
      payload: input.payload,
      orgId: input.orgId === undefined ? (auth?.orgId ?? null) : input.orgId,
      actor,
      // One correlation id per user action, across every event it causes.
      correlationId: handling?.correlationId ?? request?.requestId ?? newId(),
      causationId: handling?.eventId ?? null,
      clock: this.clock,
    }) as DomainEvent<D>;
    const { traceparent } = injectTraceContext() as { traceparent?: string };
    await this.outbox.insert({
      id: event.id,
      type: event.type,
      version: event.version,
      organizationId: event.orgId,
      payload: event.payload as Record<string, unknown>,
      actor: event.actor,
      correlationId: event.correlationId,
      causationId: event.causationId,
      context: {
        ...(request?.ip ? { ip: request.ip } : {}),
        ...(request?.userAgent ? { userAgent: request.userAgent } : {}),
        ...(traceparent ? { traceparent } : {}),
      },
      occurredAt: new Date(event.occurredAt),
    });
    await getExecutor(this.db).execute(sql`SELECT pg_notify(${OUTBOX_CHANNEL}, '')`);
    return event;
  }
}
