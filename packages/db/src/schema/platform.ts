// Platform (BF-012): the transactional outbox. Use cases insert events in their own transaction; the relay delivers
// them to subscribers through BullMQ and marks them dispatched.

import type { Actor } from '@bf/contracts';
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id } from '../columns.ts';

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

/**
 * LLM call ledger (BF-013): one row per gateway call (and per cache hit), for cost, budgets and usage reports.
 * No foreign key: spend history outlives workspaces.
 */
export const llmCalls = pgTable(
  'llm_calls',
  {
    id: id(),
    organizationId: uuid(),
    task: text().notNull(),
    promptVersion: integer(),
    provider: text().notNull(),
    model: text().notNull(),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    cachedTokens: integer().notNull().default(0),
    /** USD; null when the model has no configured price. */
    costUsd: numeric({ precision: 12, scale: 6, mode: 'number' }),
    latencyMs: integer().notNull(),
    status: text().$type<'ok' | 'cached' | 'error'>().notNull(),
    errorCode: text(),
    traceId: text(),
    createdAt: tz().notNull().defaultNow(),
  },
  (table) => [
    index('llm_calls_organization_id_created_at_idx').on(table.organizationId, table.createdAt),
    check('llm_calls_status_check', sql`${table.status} IN ('ok', 'cached', 'error')`),
  ],
);

/** Deployment-wide key/value state (e.g. `taxonomy_version`, set by the taxonomy seed). */
export const appMeta = pgTable('app_meta', {
  key: text().primaryKey(),
  value: jsonb().$type<unknown>().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
