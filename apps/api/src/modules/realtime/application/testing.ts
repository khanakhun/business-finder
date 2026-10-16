// In-memory adapters for unit-testing notifications (the Drizzle adapters are covered by notifications.int.test.ts).

import { newId } from '@bf/contracts';
import type {
  NewNotification,
  NotificationListFilter,
  NotificationPreferenceRepository,
  NotificationRecord,
  NotificationRepository,
  PreferenceRecord,
} from './notification-ports.ts';

export class InMemoryNotifications implements NotificationRepository {
  rows: Array<NotificationRecord & { sourceEventId: string | null }> = [];
  private clock = Date.parse('2026-10-15T00:00:00Z');

  async insert(notification: NewNotification) {
    if (
      notification.sourceEventId &&
      this.rows.some(
        (r) => r.sourceEventId === notification.sourceEventId && r.userId === notification.userId,
      )
    ) {
      return undefined;
    }
    this.clock += 1000;
    const row = { ...notification, id: newId(), readAt: null, createdAt: new Date(this.clock) };
    this.rows.push(row);
    return row;
  }

  async list(filter: NotificationListFilter) {
    return this.rows
      .filter((r) => r.organizationId === filter.organizationId && r.userId === filter.userId)
      .filter((r) => !filter.unreadOnly || r.readAt === null)
      .filter((r) => !filter.before || r.createdAt < filter.before.createdAt)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, filter.limit);
  }

  async unreadCount(organizationId: string, userId: string) {
    return this.rows.filter((r) => r.organizationId === organizationId && r.userId === userId && !r.readAt)
      .length;
  }

  async markRead(organizationId: string, userId: string, id: string, at: Date) {
    const row = this.rows.find(
      (r) => r.id === id && r.organizationId === organizationId && r.userId === userId,
    );
    if (!row) return false;
    this.rows = this.rows.map((r) => (r === row ? { ...r, readAt: r.readAt ?? at } : r));
    return true;
  }

  async markAllRead(organizationId: string, userId: string, at: Date) {
    let n = 0;
    this.rows = this.rows.map((r) => {
      if (r.organizationId !== organizationId || r.userId !== userId || r.readAt) return r;
      n++;
      return { ...r, readAt: at };
    });
    return n;
  }
}

export class InMemoryPreferences implements NotificationPreferenceRepository {
  readonly saved = new Map<string, PreferenceRecord[]>();

  async list(userId: string, organizationId: string) {
    return this.saved.get(`${userId}|${organizationId}`) ?? [];
  }

  async upsert(userId: string, organizationId: string, preferences: readonly PreferenceRecord[]) {
    const key = `${userId}|${organizationId}`;
    const merged = new Map((this.saved.get(key) ?? []).map((p) => [p.type, p]));
    for (const p of preferences) merged.set(p.type, p);
    this.saved.set(key, [...merged.values()]);
  }
}
