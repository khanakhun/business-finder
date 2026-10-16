import type { DomainEvent, EventDefinition } from '@bf/contracts';
import type { OutboxContext } from '@bf/db/schema';
import type { Logger } from '@bf/observability';
import { SetMetadata } from '@nestjs/common';
import type { z } from 'zod';

export const ON_DOMAIN_EVENT = Symbol('bf.on-domain-event');

/** What a subscriber receives besides the event. */
export interface DeliveryMeta {
  /** Request facts recorded with the event (client IP, user agent), when it came from an HTTP request. */
  readonly context: OutboxContext;
  readonly attempt: number;
  /** Aborted on cancellation or worker shutdown. */
  readonly signal: AbortSignal;
  readonly logger: Logger;
}

export type AnyEventDefinition = EventDefinition<string, z.ZodType>;

export type DomainEventHandler<D extends AnyEventDefinition = AnyEventDefinition> = (
  event: DomainEvent<D>,
  meta: DeliveryMeta,
) => Promise<void>;

export interface SubscriptionSpec {
  readonly id: string;
  readonly events: readonly AnyEventDefinition[];
}

const SUBSCRIBER_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/**
 * Subscribes an application handler to one or more events (Observer). `id` (`<context>.<name>`) is stable: it keys
 * idempotency (`<eventId>:<id>`), so renaming it re-delivers past events. Handlers must be idempotent anyway.
 *
 *   @OnDomainEvent([MemberInvited], { id: 'workspace.audit-identity' })
 *   async onInvited(event: DomainEvent<typeof MemberInvited>, meta: DeliveryMeta) { … }
 */
export function OnDomainEvent(
  events: AnyEventDefinition | readonly AnyEventDefinition[],
  options: { readonly id: string },
): MethodDecorator {
  if (!SUBSCRIBER_ID.test(options.id))
    throw new Error(`Subscriber id "${options.id}" must look like "context.name"`);
  const list = Array.isArray(events) ? events : [events as AnyEventDefinition];
  if (list.length === 0) throw new Error(`Subscriber ${options.id} subscribes to no event`);
  return SetMetadata(ON_DOMAIN_EVENT, { id: options.id, events: list } satisfies SubscriptionSpec);
}
