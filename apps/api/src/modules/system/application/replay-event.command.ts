import { ConflictError, ForbiddenError, NotFoundError, newId, type ReplayEventAccepted } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { OutboxRepository } from '../../platform/events/outbox.repository.ts';
import { SubscriberRegistry } from '../../platform/events/subscriber-registry.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { AuditLogger } from '../../workspace/index.ts';
import { EVENT_REPLAY_QUEUE, type EventReplayQueue } from './ports.ts';

/**
 * Re-delivers one of the workspace's recorded events to one subscriber (owners only), e.g. after fixing a
 * subscriber bug. A fresh idempotency key makes the subscriber run again; subscribers must stay idempotent.
 */
@Injectable()
export class ReplayEventCommand {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly registry: SubscriberRegistry,
    @Inject(EVENT_REPLAY_QUEUE) private readonly queue: EventReplayQueue,
    private readonly audit: AuditLogger,
  ) {}

  async execute(auth: AuthContext, eventId: string, subscriberId: string): Promise<ReplayEventAccepted> {
    if (auth.role !== 'owner') throw new ForbiddenError('Only a workspace owner can replay events.');
    const event = await this.outbox.find(eventId);
    // Another workspace's (or a platform) event is indistinguishable from a missing one.
    if (!event || event.organizationId !== auth.orgId) throw new NotFoundError('Event', eventId);
    if (!this.registry.get(subscriberId)) throw new NotFoundError('Subscriber', subscriberId);
    if (!this.registry.subscribersFor(event.type, event.version).some((s) => s.id === subscriberId)) {
      throw new ConflictError(`${subscriberId} does not subscribe to ${event.type}.`, {
        details: { reason: 'NOT_SUBSCRIBED' },
      });
    }
    const jobId = await this.queue.enqueue({
      eventId,
      subscriberId,
      orgId: event.organizationId,
      idempotencyKey: `${eventId}:${subscriberId}:replay:${newId()}`,
    });
    await this.audit.record({
      auth,
      action: 'events.replayed',
      entityType: 'event',
      entityId: eventId,
      metadata: { subscriberId, eventType: event.type },
    });
    return { jobId };
  }
}
