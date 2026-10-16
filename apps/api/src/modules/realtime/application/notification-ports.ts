import type { NotificationType } from '@bf/contracts';

export interface NotificationRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string | null;
  readonly type: NotificationType;
  readonly titleKey: string;
  readonly bodyKey: string | null;
  readonly params: Record<string, string | number>;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly link: string | null;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

export type NewNotification = Omit<NotificationRecord, 'id' | 'readAt' | 'createdAt'> & {
  readonly sourceEventId: string | null;
};

export interface NotificationListFilter {
  readonly organizationId: string;
  readonly userId: string;
  readonly unreadOnly: boolean;
  readonly before?: { readonly createdAt: Date; readonly id: string };
  readonly limit: number;
}

/** Port: `notifications`, always scoped by workspace and recipient. */
export interface NotificationRepository {
  /** Undefined when the same event already notified this user (idempotent). */
  insert(notification: NewNotification): Promise<NotificationRecord | undefined>;
  list(filter: NotificationListFilter): Promise<NotificationRecord[]>;
  unreadCount(organizationId: string, userId: string): Promise<number>;
  markRead(organizationId: string, userId: string, id: string, at: Date): Promise<boolean>;
  markAllRead(organizationId: string, userId: string, at: Date): Promise<number>;
}
export const NOTIFICATION_REPOSITORY = Symbol('NotificationRepository');

export interface PreferenceRecord {
  readonly type: NotificationType;
  readonly inApp: boolean;
  readonly email: boolean;
}

/** Port: `notification_preferences`. */
export interface NotificationPreferenceRepository {
  list(userId: string, organizationId: string): Promise<PreferenceRecord[]>;
  upsert(userId: string, organizationId: string, preferences: readonly PreferenceRecord[]): Promise<void>;
}
export const NOTIFICATION_PREFERENCE_REPOSITORY = Symbol('NotificationPreferenceRepository');
