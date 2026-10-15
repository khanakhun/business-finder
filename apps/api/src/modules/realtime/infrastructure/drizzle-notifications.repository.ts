import { type DbClient, getExecutor } from '@bf/db';
import { notificationPreferences, notifications } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type {
  NewNotification,
  NotificationListFilter,
  NotificationPreferenceRepository,
  NotificationRecord,
  NotificationRepository,
  PreferenceRecord,
} from '../application/notification-ports.ts';

const toRecord = (row: typeof notifications.$inferSelect): NotificationRecord => ({
  id: row.id,
  organizationId: row.organizationId,
  userId: row.userId,
  type: row.type,
  titleKey: row.titleKey,
  bodyKey: row.bodyKey,
  params: row.params,
  entityType: row.entityType,
  entityId: row.entityId,
  link: row.link,
  readAt: row.readAt,
  createdAt: row.createdAt,
});

const recipient = (organizationId: string, userId: string) =>
  and(eq(notifications.organizationId, organizationId), eq(notifications.userId, userId));

@Injectable()
export class DrizzleNotificationRepository implements NotificationRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async insert(notification: NewNotification): Promise<NotificationRecord | undefined> {
    const [row] = await getExecutor(this.db)
      .insert(notifications)
      .values(notification)
      .onConflictDoNothing({ target: [notifications.sourceEventId, notifications.userId] })
      .returning();
    return row ? toRecord(row) : undefined;
  }

  async list(filter: NotificationListFilter): Promise<NotificationRecord[]> {
    const rows = await getExecutor(this.db)
      .select()
      .from(notifications)
      .where(
        and(
          recipient(filter.organizationId, filter.userId),
          filter.unreadOnly ? isNull(notifications.readAt) : undefined,
          filter.before
            ? sql`(${notifications.createdAt}, ${notifications.id}) < (${filter.before.createdAt.toISOString()}::timestamptz, ${filter.before.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(filter.limit);
    return rows.map(toRecord);
  }

  async unreadCount(organizationId: string, userId: string): Promise<number> {
    const [row] = await getExecutor(this.db)
      .select({ n: count() })
      .from(notifications)
      .where(and(recipient(organizationId, userId), isNull(notifications.readAt)));
    return row?.n ?? 0;
  }

  async markRead(organizationId: string, userId: string, id: string, at: Date): Promise<boolean> {
    const rows = await getExecutor(this.db)
      .update(notifications)
      // Keeps the first read time when marked twice.
      .set({ readAt: sql`coalesce(${notifications.readAt}, ${at.toISOString()}::timestamptz)` })
      .where(and(recipient(organizationId, userId), eq(notifications.id, id)))
      .returning({ id: notifications.id });
    return rows.length > 0;
  }

  async markAllRead(organizationId: string, userId: string, at: Date): Promise<number> {
    const rows = await getExecutor(this.db)
      .update(notifications)
      .set({ readAt: at })
      .where(and(recipient(organizationId, userId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return rows.length;
  }
}

@Injectable()
export class DrizzleNotificationPreferenceRepository implements NotificationPreferenceRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async list(userId: string, organizationId: string): Promise<PreferenceRecord[]> {
    return getExecutor(this.db)
      .select({
        type: notificationPreferences.type,
        inApp: notificationPreferences.inApp,
        email: notificationPreferences.email,
      })
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.userId, userId),
          eq(notificationPreferences.organizationId, organizationId),
        ),
      );
  }

  async upsert(
    userId: string,
    organizationId: string,
    preferences: readonly PreferenceRecord[],
  ): Promise<void> {
    if (preferences.length === 0) return;
    await getExecutor(this.db)
      .insert(notificationPreferences)
      .values(preferences.map((p) => ({ userId, organizationId, ...p })))
      .onConflictDoUpdate({
        target: [
          notificationPreferences.userId,
          notificationPreferences.organizationId,
          notificationPreferences.type,
        ],
        set: {
          inApp: sql`excluded.in_app`,
          email: sql`excluded.email`,
          updatedAt: new Date(),
        },
      });
  }
}
