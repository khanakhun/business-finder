import { type DomainEvent, EventDeliveryJob, getEventDefinition } from '@bf/contracts';
import { metrics, withLogContext } from '@bf/observability';
import { type JobContext, QUEUES } from '@bf/queue';
import { Processor } from '@nestjs/bullmq';
import { UnrecoverableError } from 'bullmq';
import type { z } from 'zod';
import { TypedProcessor } from '../queue/typed-processor.ts';
import { runInEventContext } from './event-context.ts';
import { OutboxRepository } from './outbox.repository.ts';
import { SubscriberRegistry } from './subscriber-registry.ts';

const handled = () =>
  metrics.counter({
    name: 'bf_events_handled_total',
    help: 'Subscriber deliveries by outcome',
    labelNames: ['subscriber', 'outcome'],
  });

/**
 * Runs one subscriber for one event (Competing Consumers). Each event × subscriber is its own job: a failing
 * subscriber retries with backoff without affecting the others, and the runner's idempotency guard keeps a
 * completed delivery from running again.
 */
@Processor(QUEUES.events.name, { concurrency: QUEUES.events.concurrency })
export class EventDeliveryProcessor extends TypedProcessor<typeof EventDeliveryJob, { handled: boolean }> {
  protected readonly definition = EventDeliveryJob;

  constructor(
    private readonly outbox: OutboxRepository,
    private readonly registry: SubscriberRegistry,
  ) {
    super();
  }

  async handle(
    payload: z.output<typeof EventDeliveryJob.schema>,
    context: JobContext,
  ): Promise<{ handled: boolean }> {
    const subscriber = this.registry.get(payload.subscriberId);
    const row = await this.outbox.find(payload.eventId);
    if (!subscriber || !row) {
      // A removed subscriber, or an event purged by retention: nothing left to do.
      context.logger.warn(
        { eventId: payload.eventId, subscriberId: payload.subscriberId },
        'delivery skipped',
      );
      handled().inc({ subscriber: payload.subscriberId, outcome: 'skipped' });
      return { handled: false };
    }
    const definition = getEventDefinition(row.type, row.version);
    if (!definition) throw new UnrecoverableError(`Unknown event ${row.type}@${row.version}`);
    const event = definition.schema.parse({
      id: row.id,
      type: row.type,
      version: row.version,
      occurredAt: row.occurredAt.toISOString(),
      orgId: row.organizationId,
      actor: row.actor,
      correlationId: row.correlationId,
      causationId: row.causationId,
      payload: row.payload,
    }) as DomainEvent<typeof definition>;
    const fields = {
      eventId: row.id,
      eventType: row.type,
      subscriberId: subscriber.id,
      correlationId: row.correlationId,
    };
    try {
      await runInEventContext(
        { eventId: row.id, correlationId: row.correlationId, subscriberId: subscriber.id },
        () =>
          withLogContext(fields, () =>
            subscriber.handle(event, {
              context: row.context,
              attempt: context.attempt,
              signal: context.signal,
              logger: context.logger.child(fields),
            }),
          ),
      );
    } catch (error) {
      handled().inc({ subscriber: subscriber.id, outcome: 'failed' });
      throw error;
    }
    handled().inc({ subscriber: subscriber.id, outcome: 'completed' });
    return { handled: true };
  }
}
