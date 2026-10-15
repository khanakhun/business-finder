// Platform (BF-012): the transactional outbox. Use cases insert events in their own transaction; the relay delivers
// them to subscribers through BullMQ and marks them dispatched.

import type { Actor } from '@bf/contracts';
import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const tz = () => timestamp({ withTimezone: true });

/** Delivery metadata that is not part of the event (who made the request), for subscribers such as the audit log. */
export interface OutboxContext {
  readonly ip?: string;
  readonly userAgent?: string;
  /** W3C trace context of the recording request, so delivery continues its trace. */
  readonly traceparent?: string;
}

export const outboxEvents = pgTable(
  'outbox_events',
  {
    /** The event id (UUIDv7 from the envelope). */
    id: uuid().primaryKey(),
    type: text().notNull(),
    version: integer().notNull(),
    organizationId: uuid(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    actor: jsonb().$type<Actor>().notNull(),
    correlationId: text().notNull(),
    causationId: text(),
    context: jsonb().$type<OutboxContext>().notNull().default({}),
    occurredAt: tz().notNull(),
    dispatchedAt: tz(),
    attempts: integer().notNull().default(0),
    lastError: text(),
    /** Not before this time (relay backoff after a failed dispatch). */
    availableAt: tz().notNull().defaultNow(),
  },
  (table) => [
    // The relay only ever scans pending events.
    index('outbox_events_pending_idx').on(table.availableAt).where(sql`${table.dispatchedAt} IS NULL`),
    index('outbox_events_occurred_at_idx').on(table.occurredAt),
  ],
);
