// Discovery context: provider usage metering (BF-018), runs and tasks (BF-020).

import {
  DISCOVERY_PROVIDER_IDS,
  type DiscoveryIntent,
  type DiscoveryRunOptions,
  type ProviderId,
  type ProviderQuery,
  RUN_END_REASONS,
  RUN_STATUSES,
  type RunEndReason,
  type RunStatus,
  TASK_STATUSES,
  type TaskStatus,
} from '@bf/contracts';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from '../columns.ts';
import { geographyMultiPolygon } from '../types/geography.ts';
import { organization, user } from './auth.ts';
import { geoAreas } from './geo.ts';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * Calls, results and estimated cost per workspace, provider, SKU and UTC day. `billing_scope` is whose provider
 * account paid (the workspace id for its own key, `global` for the deployment key): free monthly allowances are
 * per account, so they are counted per scope.
 */
export const providerUsage = pgTable(
  'provider_usage',
  {
    organizationId: uuid()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    provider: text().$type<ProviderId>().notNull(),
    sku: text().notNull(),
    day: date({ mode: 'string' }).notNull(),
    billingScope: text().notNull(),
    calls: integer().notNull().default(0),
    results: integer().notNull().default(0),
    costUsd: numeric({ precision: 12, scale: 6, mode: 'number' }).notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    primaryKey({
      name: 'provider_usage_pkey',
      columns: [table.organizationId, table.provider, table.sku, table.day, table.billingScope],
    }),
    // Free-allowance sums per account and month.
    index('idx_provider_usage__billing_scope_provider_sku_day').on(
      table.billingScope,
      table.provider,
      table.sku,
      table.day,
    ),
    check('ck_provider_usage__provider', sql`${table.provider} IN (${inList(DISCOVERY_PROVIDER_IDS)})`),
    check(
      'ck_provider_usage__counts',
      sql`${table.calls} >= 0 AND ${table.results} >= 0 AND ${table.costUsd} >= 0`,
    ),
  ],
);

const tz = () => timestamp({ withTimezone: true });
const usd = () => numeric({ precision: 12, scale: 6, mode: 'number' }).notNull().default(0);
const count = () => integer().notNull().default(0);

/**
 * A discovery run (DOMAIN.md §3.2): the source of truth for its lifecycle; counters are updated with atomic
 * increments. `reserved_usd` holds the estimated cost of calls in flight: a call starts only if
 * `cost_usd + reserved_usd + estimate <= budget_usd`, so the budget is never exceeded.
 */
export const discoveryRuns = pgTable(
  'discovery_runs',
  {
    id: id(),
    organizationId: uuid()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    createdBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    intent: jsonb().$type<DiscoveryIntent>().notNull(),
    areaId: uuid().references(() => geoAreas.id, { onDelete: 'set null' }),
    areaGeometry: geographyMultiPolygon().notNull(),
    providers: text().array().$type<ProviderId[]>().notNull(),
    options: jsonb().$type<DiscoveryRunOptions>().notNull(),
    status: text().$type<RunStatus>().notNull().default('queued'),
    reason: text().$type<RunEndReason>(),
    budgetUsd: numeric({ precision: 12, scale: 6, mode: 'number' }).notNull(),
    costUsd: usd(),
    reservedUsd: usd(),
    budgetExhausted: boolean().notNull().default(false),
    tasksTotal: count(),
    tasksDone: count(),
    tasksFailed: count(),
    tasksSkipped: count(),
    recordsFetched: count(),
    createdCount: count(),
    mergedCount: count(),
    unchangedCount: count(),
    possibleDuplicates: count(),
    failedRecords: count(),
    /** Ingest jobs enqueued and not yet finished: the run completes only when this is 0. */
    ingestsPending: count(),
    idempotencyKey: text(),
    /** Hash of the start request: a reused idempotency key with a different request is a conflict. */
    requestHash: text(),
    error: text(),
    startedAt: tz(),
    /** Set with the root tasks: a running run is never finalized before it is planned. */
    plannedAt: tz(),
    finishedAt: tz(),
    ...timestamps(),
  },
  (table) => [
    index('idx_discovery_runs__organization_id_created_at').on(table.organizationId, table.createdAt),
    index('idx_discovery_runs__status').on(table.status),
    uniqueIndex('uq_discovery_runs__organization_id_idempotency_key').on(
      table.organizationId,
      table.idempotencyKey,
    ),
    check('ck_discovery_runs__status', sql`${table.status} IN (${inList(RUN_STATUSES)})`),
    check(
      'ck_discovery_runs__reason',
      sql`${table.reason} IS NULL OR ${table.reason} IN (${inList(RUN_END_REASONS)})`,
    ),
    check(
      'ck_discovery_runs__money',
      sql`${table.budgetUsd} >= 0 AND ${table.costUsd} >= 0 AND ${table.reservedUsd} >= 0`,
    ),
  ],
);

/**
 * One provider call to make for a run: provider × category × tile (× page). Children come from saturated tiles
 * (quadtree, `depth`) and continuations (next page / scraper polls). `dedupe_key` makes task creation idempotent.
 */
export const discoveryTasks = pgTable(
  'discovery_tasks',
  {
    id: id(),
    runId: uuid()
      .notNull()
      .references(() => discoveryRuns.id, { onDelete: 'cascade' }),
    parentTaskId: uuid().references((): AnyPgColumn => discoveryTasks.id, { onDelete: 'set null' }),
    provider: text().$type<ProviderId>().notNull(),
    categoryId: uuid(),
    query: jsonb().$type<ProviderQuery>().notNull(),
    depth: integer().notNull().default(0),
    dedupeKey: text().notNull(),
    status: text().$type<TaskStatus>().notNull().default('queued'),
    attempt: count(),
    records: count(),
    saturated: boolean().notNull().default(false),
    reservedUsd: usd(),
    costUsd: usd(),
    /**
     * Records fetched and not yet ingested: kept in the database (not in the queue) so a crash between fetch and
     * ingest never costs a second provider call. Cleared once ingested.
     */
    pendingRecords: jsonb().$type<unknown[]>(),
    ingestedAt: tz(),
    /** Not before this time (scraper polls, provider back-off). */
    notBefore: tz(),
    heartbeatAt: tz(),
    error: text(),
    ...timestamps(),
  },
  (table) => [
    index('idx_discovery_tasks__run_id_status').on(table.runId, table.status),
    uniqueIndex('uq_discovery_tasks__run_id_dedupe_key').on(table.runId, table.dedupeKey),
    index('idx_discovery_tasks__status_heartbeat_at').on(table.status, table.heartbeatAt),
    check('ck_discovery_tasks__status', sql`${table.status} IN (${inList(TASK_STATUSES)})`),
    check('ck_discovery_tasks__provider', sql`${table.provider} IN (${inList(DISCOVERY_PROVIDER_IDS)})`),
  ],
);
