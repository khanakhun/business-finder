import { type DomainEvent, MemberJoined, TestNotificationRequested } from '@bf/contracts';
import { Injectable } from '@nestjs/common';
import { MemberDirectory } from '../../identity/index.ts';
import { OnDomainEvent } from '../../platform/events/on-domain-event.decorator.ts';
import { NotificationService } from './notification.service.ts';

/** Turns domain events into notifications (each feature ticket adds its own handlers here or in its module). */
@Injectable()
export class NotificationSubscribers {
  constructor(
    private readonly notifications: NotificationService,
    private readonly directory: MemberDirectory,
  ) {}

  @OnDomainEvent(MemberJoined, { id: 'realtime.notify-member-joined' })
  async memberJoined(event: DomainEvent<typeof MemberJoined>): Promise<void> {
    if (!event.orgId) return;
    const joined = await this.directory.contact(event.payload.userId);
    await this.notifications.notify({
      organizationId: event.orgId,
      recipients: 'members',
      exclude: [event.payload.userId],
      type: 'member_joined',
      params: { name: joined?.name ?? '' },
      entity: { type: 'member', id: event.payload.memberId },
      link: '/settings/members',
      sourceEventId: event.id,
    });
  }

  @OnDomainEvent(TestNotificationRequested, { id: 'realtime.notify-test' })
  async test(event: DomainEvent<typeof TestNotificationRequested>): Promise<void> {
    if (!event.orgId) return;
    await this.notifications.notify({
      organizationId: event.orgId,
      recipients: [event.payload.userId],
      type: 'system_test',
      link: '/notifications',
      sourceEventId: event.id,
    });
  }
}
