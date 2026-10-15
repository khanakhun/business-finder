import { DiscoveryRunCompleted, type DomainEvent } from '@bf/contracts';
import { Injectable } from '@nestjs/common';
import { OnDomainEvent } from '../../platform/events/on-domain-event.decorator.ts';
import { NotificationService } from '../../realtime/index.ts';

/** Tells whoever started a run that it ended (notification type `discovery_completed`, BF-012). */
@Injectable()
export class DiscoveryRunNotifications {
  constructor(private readonly notifications: NotificationService) {}

  @OnDomainEvent(DiscoveryRunCompleted, { id: 'discovery.notify-run-completed' })
  async runCompleted(event: DomainEvent<typeof DiscoveryRunCompleted>): Promise<void> {
    const { runId, createdBy, status, counts } = event.payload;
    if (!event.orgId || !createdBy) return;
    await this.notifications.notify({
      organizationId: event.orgId,
      recipients: [createdBy],
      type: 'discovery_completed',
      params: { status, created: counts.created, merged: counts.merged },
      entity: { type: 'discovery_run', id: runId },
      link: `/discovery/runs/${runId}`,
      sourceEventId: event.id,
    });
  }
}
