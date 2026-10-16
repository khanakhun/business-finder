import {
  type Clock,
  decodeCursor,
  encodeCursor,
  ForbiddenError,
  NOTIFICATION_TYPE_NAMES,
  NotFoundError,
  type Notification,
  type NotificationPage,
  type NotificationPreferences,
  type NotificationQuery,
  type TestNotificationAccepted,
  TestNotificationRequested,
  type UpdateNotificationPreferencesRequest,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { APP_ENV, type AppEnv } from '../../platform/config/app-env.ts';
import { EventRecorder } from '../../platform/events/event-recorder.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { effectivePreference } from './notification.service.ts';
import {
  NOTIFICATION_PREFERENCE_REPOSITORY,
  NOTIFICATION_REPOSITORY,
  type NotificationPreferenceRepository,
  type NotificationRecord,
  type NotificationRepository,
} from './notification-ports.ts';

/** Notifications belong to a signed-in user in their active workspace (API keys have no inbox). */
export function recipientOf(auth: AuthContext): { readonly orgId: string; readonly userId: string } {
  if (auth.method !== 'session' || !auth.userId || !auth.orgId) {
    throw new ForbiddenError('Notifications belong to signed-in users.');
  }
  return { orgId: auth.orgId, userId: auth.userId };
}

export const toNotification = (record: NotificationRecord): Notification => ({
  id: record.id,
  type: record.type,
  titleKey: record.titleKey,
  bodyKey: record.bodyKey,
  params: record.params,
  entityType: record.entityType,
  entityId: record.entityId,
  link: record.link,
  readAt: record.readAt?.toISOString() ?? null,
  createdAt: record.createdAt.toISOString(),
});

@Injectable()
export class ListNotificationsQuery {
  constructor(@Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository) {}

  async execute(auth: AuthContext, query: NotificationQuery): Promise<NotificationPage> {
    const { orgId, userId } = recipientOf(auth);
    const before = query.cursor ? await positionOf(query.cursor) : undefined;
    const [rows, unreadCount] = await Promise.all([
      this.notifications.list({
        organizationId: orgId,
        userId,
        unreadOnly: query.unread,
        limit: query.limit + 1,
        ...(before ? { before } : {}),
      }),
      this.notifications.unreadCount(orgId, userId),
    ]);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(toNotification),
      nextCursor:
        rows.length > query.limit && last
          ? await encodeCursor({ sort: [last.createdAt.toISOString()], id: last.id })
          : null,
      unreadCount,
    };
  }
}

async function positionOf(cursor: string): Promise<{ createdAt: Date; id: string }> {
  const data = await decodeCursor(cursor);
  const [at] = data.sort;
  const createdAt = typeof at === 'string' ? new Date(at) : undefined;
  if (!createdAt || Number.isNaN(createdAt.getTime()) || !z.uuid().safeParse(data.id).success) {
    throw new ValidationError('Invalid cursor.', [{ path: ['cursor'], message: 'Invalid cursor' }]);
  }
  return { createdAt, id: data.id };
}

@Injectable()
export class MarkNotificationsReadCommands {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async markRead(auth: AuthContext, id: string): Promise<void> {
    const { orgId, userId } = recipientOf(auth);
    if (!(await this.notifications.markRead(orgId, userId, id, this.clock.now()))) {
      throw new NotFoundError('Notification', id);
    }
  }

  async markAllRead(auth: AuthContext): Promise<void> {
    const { orgId, userId } = recipientOf(auth);
    await this.notifications.markAllRead(orgId, userId, this.clock.now());
  }
}

@Injectable()
export class NotificationPreferencesUseCases {
  constructor(
    @Inject(NOTIFICATION_PREFERENCE_REPOSITORY)
    private readonly preferences: NotificationPreferenceRepository,
  ) {}

  async get(auth: AuthContext): Promise<NotificationPreferences> {
    const { orgId, userId } = recipientOf(auth);
    const saved = await this.preferences.list(userId, orgId);
    return { items: NOTIFICATION_TYPE_NAMES.map((type) => effectivePreference(type, saved)) };
  }

  async update(
    auth: AuthContext,
    body: UpdateNotificationPreferencesRequest,
  ): Promise<NotificationPreferences> {
    const { orgId, userId } = recipientOf(auth);
    await this.preferences.upsert(userId, orgId, body.items);
    return this.get(auth);
  }
}

/** Development/E2E only: records an event whose subscriber notifies the caller (outbox → worker → SSE → bell). */
@Injectable()
export class TriggerTestNotificationCommand {
  constructor(
    private readonly events: EventRecorder,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async execute(auth: AuthContext): Promise<TestNotificationAccepted> {
    if (this.env.NODE_ENV === 'production') throw new NotFoundError('Route', 'POST /v1/notifications/test');
    const { orgId, userId } = recipientOf(auth);
    const event = await this.events.record(TestNotificationRequested, { payload: { userId }, orgId });
    return { eventId: event.id };
  }
}
