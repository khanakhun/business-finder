import { z } from 'zod';
import { EventId, newId, OrgId } from './ids.ts';
import type { Clock } from './time.ts';
import { IsoDateTimeSchema } from './time.ts';

export const ActorSchema = z.object({
  type: z.enum(['user', 'system', 'job']),
  id: z.string().nullable(),
});
export type Actor = z.infer<typeof ActorSchema>;

/** Event type names: `<context>.<entity>[.<detail>]`, past tense (`business.created`, `site.lead.captured`). */
const EVENT_TYPE = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;

/** Envelope schema for one event type/version (DOMAIN.md §4). Consumers dedupe on `id`. */
export function domainEventEnvelope<TType extends string, TPayload extends z.ZodType>(
  type: TType,
  version: number,
  payload: TPayload,
) {
  return z.object({
    id: EventId,
    type: z.literal(type),
    version: z.literal(version),
    occurredAt: IsoDateTimeSchema,
    orgId: OrgId.nullable(),
    actor: ActorSchema,
    correlationId: z.string().min(1),
    causationId: z.string().min(1).nullable(),
    payload,
  });
}

export interface EventDefinition<TType extends string, TPayload extends z.ZodType> {
  readonly type: TType;
  readonly version: number;
  readonly schema: ReturnType<typeof domainEventEnvelope<TType, TPayload>>;
  /** Builds and validates an envelope with a fresh id and `occurredAt` from the clock. */
  create(input: {
    readonly payload: z.input<TPayload>;
    readonly orgId: string | null;
    readonly actor: Actor;
    readonly correlationId: string;
    readonly causationId?: string | null;
    readonly clock: Clock;
  }): z.output<ReturnType<typeof domainEventEnvelope<TType, TPayload>>>;
}

const eventRegistry = new Map<string, EventDefinition<string, z.ZodType>>();

/** Declares an event once; the registry rejects duplicate type+version pairs. */
export function defineEvent<TType extends string, TPayload extends z.ZodType>(
  type: TType,
  version: number,
  payload: TPayload,
): EventDefinition<TType, TPayload> {
  if (!EVENT_TYPE.test(type)) throw new Error(`Event type "${type}" must look like "context.entity.action"`);
  if (!Number.isInteger(version) || version < 1) throw new Error(`Event version must be a positive integer`);
  const key = `${type}@${version}`;
  if (eventRegistry.has(key)) throw new Error(`Event ${key} is already defined`);
  const schema = domainEventEnvelope(type, version, payload);
  const definition: EventDefinition<TType, TPayload> = {
    type,
    version,
    schema,
    create: (input) =>
      schema.parse({
        id: newId(),
        type,
        version,
        occurredAt: input.clock.now().toISOString(),
        orgId: input.orgId,
        actor: input.actor,
        correlationId: input.correlationId,
        causationId: input.causationId ?? null,
        payload: input.payload,
      }),
  };
  eventRegistry.set(key, definition as unknown as EventDefinition<string, z.ZodType>);
  return definition;
}

/** Looks up a registered event (e.g. when deserialising from the outbox). */
export function getEventDefinition(
  type: string,
  version: number,
): EventDefinition<string, z.ZodType> | undefined {
  return eventRegistry.get(`${type}@${version}`);
}

export function registeredEvents(): ReadonlyArray<{ type: string; version: number }> {
  return [...eventRegistry.values()].map(({ type, version }) => ({ type, version }));
}
