// Realtime context (BF-012): in-app notifications and per-user delivery preferences.

import type { NotificationType } from '@bf/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id } from '../columns.ts';
import { organization, user } from './auth.ts';

const tz = () => timestamp({ withTimezone: true });

/** One row per recipient (fanned out when created), so read state is per user. */
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    organizationId: uuid()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    /** Recipient; null is reserved for workspace-wide notices without per-user read state. */
    userId: uuid().references(() => user.id, { onDelete: 'cascade' }),
    type: text().$type<NotificationType>().notNull(),
    titleKey: text().notNull(),
    bodyKey: text(),
    params: jsonb().$type<Record<string, string | number>>().notNull().default({}),
    entityType: text(),
    entityId: text(),
    /** Dashboard path (always relative). */
    link: text(),
    /** The domain event that caused it: a redelivered event creates no duplicate. */
    sourceEventId: uuid(),
    readAt: tz(),
    createdAt: tz().notNull().defaultNow(),
  },
  (table) => [
    index('notifications_recipient_created_at_idx').on(
      table.organizationId,
      table.userId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index('notifications_unread_idx')
      .on(table.organizationId, table.userId)
      .where(sql`${table.readAt} IS NULL`),
    uniqueIndex('notifications_source_event_id_user_id_key').on(table.sourceEventId, table.userId),
  ],
);

/** A user's choice per workspace and type; absent rows mean the type's default. */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    userId: uuid()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    organizationId: uuid()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    type: text().$type<NotificationType>().notNull(),
    inApp: boolean().notNull(),
    email: boolean().notNull(),
    updatedAt: tz().notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.organizationId, table.type] })],
);
