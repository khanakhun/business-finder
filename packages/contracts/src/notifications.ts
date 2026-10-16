import { z } from 'zod';
import { defineEvent } from './events.ts';
import { CursorPageRequestSchema, cursorPage } from './pagination.ts';
import { IsoDateTimeSchema } from './time.ts';

// Notifications (BF-012): created from domain events by subscribers, shown in the bell and optionally emailed.

/** Every notification type and its default delivery, until the user changes their preferences. */
export const NOTIFICATION_TYPES = {
  reply_received: { inApp: true, email: true },
  lead_captured: { inApp: true, email: true },
  batch_completed: { inApp: true, email: false },
  discovery_completed: { inApp: true, email: false },
  mailbox_paused: { inApp: true, email: true },
  member_joined: { inApp: true, email: false },
  /** Development and E2E only (`POST /v1/notifications/test`). */
  system_test: { inApp: true, email: false },
} as const satisfies Record<string, { readonly inApp: boolean; readonly email: boolean }>;
export type NotificationType = keyof typeof NOTIFICATION_TYPES;
export const NOTIFICATION_TYPE_NAMES = Object.keys(NOTIFICATION_TYPES) as [
  NotificationType,
  ...NotificationType[],
];
export const NotificationTypeSchema = z.enum(NOTIFICATION_TYPE_NAMES);

const NotificationParamsSchema = z.record(z.string(), z.union([z.string().max(200), z.number()]));

export const NotificationSchema = z
  .object({
    id: z.uuid(),
    type: NotificationTypeSchema,
    titleKey: z
      .string()
      .describe('Message key the dashboard translates, e.g. `notifications.types.member_joined.title`.'),
    bodyKey: z.string().nullable(),
    params: NotificationParamsSchema,
    entityType: z.string().nullable(),
    entityId: z.string().nullable(),
    link: z
      .string()
      .regex(/^\/(?!\/)[^\s\\]*$/)
      .nullable()
      .describe('Dashboard path to open, e.g. `/settings/members` (never another site).'),
    readAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'Notification' });
export type Notification = z.infer<typeof NotificationSchema>;

export const NotificationQuerySchema = CursorPageRequestSchema.extend({
  unread: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true')
    .describe('Only unread notifications.'),
});
export type NotificationQuery = z.output<typeof NotificationQuerySchema>;

export const NotificationPageSchema = cursorPage(NotificationSchema)
  .extend({ unreadCount: z.number().int().nonnegative() })
  .meta({ id: 'NotificationPage' });
export type NotificationPage = z.infer<typeof NotificationPageSchema>;

export const NotificationPreferenceSchema = z
  .object({ type: NotificationTypeSchema, inApp: z.boolean(), email: z.boolean() })
  .meta({ id: 'NotificationPreference' });
export type NotificationPreference = z.infer<typeof NotificationPreferenceSchema>;

export const NotificationPreferencesSchema = z
  .object({ items: z.array(NotificationPreferenceSchema) })
  .meta({ id: 'NotificationPreferences' });
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

export const UpdateNotificationPreferencesRequestSchema = z
  .object({ items: z.array(NotificationPreferenceSchema).min(1).max(NOTIFICATION_TYPE_NAMES.length) })
  .meta({ id: 'UpdateNotificationPreferencesRequest' });
export type UpdateNotificationPreferencesRequest = z.infer<typeof UpdateNotificationPreferencesRequestSchema>;

/** Realtime event telling a user's open tabs to refresh the bell (`payload.userId`). */
export const NOTIFICATION_CREATED = 'notification.created';

/** A user asked for a test notification (development/E2E): exercises outbox → subscriber → realtime → bell. */
export const TestNotificationRequested = defineEvent(
  'system.test_notification_requested',
  1,
  z.object({ userId: z.uuid() }),
);

export const TestNotificationAcceptedSchema = z.object({ eventId: z.uuid() }).meta({
  id: 'TestNotificationAccepted',
  description: 'The domain event that will produce the notification.',
});
export type TestNotificationAccepted = z.infer<typeof TestNotificationAcceptedSchema>;
