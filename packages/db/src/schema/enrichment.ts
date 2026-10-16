// Enrichment context (BF-027): runs and their steps (a DAG per run), and website snapshots from site intel.

import {
  ENRICHMENT_RUN_STATUSES,
  ENRICHMENT_SKIP_REASONS,
  ENRICHMENT_STEP_IDS,
  ENRICHMENT_STEP_STATUSES,
  ENRICHMENT_TRIGGERS,
  type EnrichmentRunStatus,
  type EnrichmentSkipReason,
  type EnrichmentStepId,
  type EnrichmentStepStatus,
  type EnrichmentTrigger,
  type SiteIntel,
} from '@bf/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from '../columns.ts';
import { organization, user } from './auth.ts';
import { businesses } from './business-graph.ts';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));
const tz = () => timestamp({ withTimezone: true });
const usd = () => numeric({ precision: 12, scale: 6, mode: 'number' }).notNull().default(0);

/**
 * One enrichment of one business, asked by one workspace (facts are global, cost is the workspace's). The source
 * of truth for its lifecycle (DOMAIN.md, ADR-0006): jobs move it between states, the reconciler rebuilds execution
 * from it. `estimated_usd` is what the planner reserved against the workspace's monthly budget.
 */
export const enrichmentRuns = pgTable(
  'enrichment_runs',
  {
    id: id(),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    triggeredByOrgId: uuid()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    requestedBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    trigger: text().$type<EnrichmentTrigger>().notNull(),
    requestedSteps: text().array().$type<EnrichmentStepId[]>().notNull(),
    force: boolean().notNull().default(false),
    status: text().$type<EnrichmentRunStatus>().notNull().default('queued'),
    estimatedUsd: usd(),
    costUsd: usd(),
    /** Golden-record fields the run's steps changed (reported in `business.enriched`). */
    changedFields: text().array().notNull().default(sql`ARRAY[]::text[]`),
    idempotencyKey: text(),
    error: text(),
    startedAt: tz(),
    finishedAt: tz(),
    ...timestamps(),
  },
  (table) => [
    // Latest run per business for a workspace (business page, listing status).
    index('idx_enrichment_runs__business_id_triggered_by_org_id_created_at').on(
      table.businessId,
      table.triggeredByOrgId,
      table.createdAt,
    ),
    // Monthly spend per workspace; reconciler scans by status.
    index('idx_enrichment_runs__triggered_by_org_id_created_at').on(table.triggeredByOrgId, table.createdAt),
    // The reconciler scans open runs not touched lately.
    index('idx_enrichment_runs__updated_at_open')
      .on(table.updatedAt)
      .where(sql`${table.status} IN ('queued', 'running')`),
    // One open run per business and workspace (the start command serializes; this is the backstop).
    uniqueIndex('uq_enrichment_runs__triggered_by_org_id_business_id_open')
      .on(table.triggeredByOrgId, table.businessId)
      .where(sql`${table.status} IN ('queued', 'running')`),
    uniqueIndex('uq_enrichment_runs__triggered_by_org_id_idempotency_key').on(
      table.triggeredByOrgId,
      table.idempotencyKey,
    ),
    check('ck_enrichment_runs__status', sql`${table.status} IN (${inList(ENRICHMENT_RUN_STATUSES)})`),
    check('ck_enrichment_runs__trigger', sql`${table.trigger} IN (${inList(ENRICHMENT_TRIGGERS)})`),
    check('ck_enrichment_runs__money', sql`${table.estimatedUsd} >= 0 AND ${table.costUsd} >= 0`),
  ],
);

/**
 * One step of a run. `depends_on` holds the step ids it waits for (within the run); a step is enqueued once every
 * dependency is terminal. `input_hash` keys idempotency (`businessId:step:inputHash`) and freshness.
 */
export const enrichmentSteps = pgTable(
  'enrichment_steps',
  {
    id: id(),
    runId: uuid()
      .notNull()
      .references(() => enrichmentRuns.id, { onDelete: 'cascade' }),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    step: text().$type<EnrichmentStepId>().notNull(),
    dependsOn: text().array().$type<EnrichmentStepId[]>().notNull().default(sql`ARRAY[]::text[]`),
    status: text().$type<EnrichmentStepStatus>().notNull().default('queued'),
    attempt: integer().notNull().default(0),
    inputHash: text(),
    /** Pointers to what the step produced (a snapshot id, artifact keys), never page content. */
    outputRef: jsonb().$type<Record<string, unknown>>(),
    estimatedUsd: usd(),
    costUsd: usd(),
    skipReason: text().$type<EnrichmentSkipReason>(),
    error: text(),
    heartbeatAt: tz(),
    /** Not before this time (a retry's backoff, a rate-limit wait): the reconciler leaves it alone until then. */
    notBefore: tz(),
    /** The job that claimed the step (cancellation signals exactly that job). */
    jobId: text(),
    startedAt: tz(),
    finishedAt: tz(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('uq_enrichment_steps__run_id_step').on(table.runId, table.step),
    index('idx_enrichment_steps__status_heartbeat_at').on(table.status, table.heartbeatAt),
    // Freshness: the last finished step of a kind for a business.
    index('idx_enrichment_steps__business_id_step_finished_at').on(
      table.businessId,
      table.step,
      table.finishedAt,
    ),
    check('ck_enrichment_steps__step', sql`${table.step} IN (${inList(ENRICHMENT_STEP_IDS)})`),
    check('ck_enrichment_steps__status', sql`${table.status} IN (${inList(ENRICHMENT_STEP_STATUSES)})`),
    check(
      'ck_enrichment_steps__skip_reason',
      sql`${table.skipReason} IS NULL OR ${table.skipReason} IN (${inList(ENRICHMENT_SKIP_REASONS)})`,
    ),
    check('ck_enrichment_steps__money', sql`${table.estimatedUsd} >= 0 AND ${table.costUsd} >= 0`),
  ],
);

type Section<K extends keyof SiteIntel> = SiteIntel[K];

/**
 * What a business's website showed at one crawl (BF-026 site intel), global like the business. Page markdown and
 * screenshots stay in object storage (keys only): crawled content is untrusted and not stored here.
 */
export const websiteSnapshots = pgTable(
  'website_snapshots',
  {
    id: id(),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    url: text().notNull(),
    finalUrl: text(),
    fetchedAt: tz().notNull(),
    reachability: text().$type<SiteIntel['reachability']>().notNull(),
    httpStatus: integer(),
    socialOnly: boolean().notNull().default(false),
    tls: jsonb().$type<Section<'tls'>>().notNull(),
    security: jsonb().$type<Section<'security'>>().notNull(),
    languages: jsonb().$type<Section<'languages'>>().notNull(),
    pages: jsonb().$type<Section<'pages'>>().notNull(),
    contacts: jsonb().$type<Section<'contacts'>>().notNull(),
    socials: jsonb().$type<Section<'socials'>>().notNull(),
    booking: jsonb().$type<Section<'booking'>>().notNull(),
    ordering: jsonb().$type<Section<'ordering'>>().notNull(),
    chat: jsonb().$type<Section<'chat'>>().notNull(),
    analytics: jsonb().$type<Section<'analytics'>>().notNull(),
    tech: jsonb().$type<Section<'tech'>>().notNull(),
    freshness: jsonb().$type<Section<'freshness'>>().notNull(),
    mobile: jsonb().$type<Section<'mobile'>>().notNull(),
    performanceHints: jsonb().$type<Section<'performanceHints'>>().notNull(),
    links: jsonb().$type<Section<'links'>>().notNull(),
    noSolicitation: jsonb().$type<Section<'noSolicitation'>>().notNull(),
    logoCandidates: jsonb().$type<Section<'logoCandidates'>>().notNull(),
    imageCandidates: jsonb().$type<Section<'imageCandidates'>>().notNull(),
    warnings: jsonb().$type<Section<'warnings'>>().notNull(),
    screenshotDesktopKey: text(),
    screenshotMobileKey: text(),
    /** Hash of the extracted facts: an identical re-crawl changes nothing downstream. */
    contentHash: text().notNull(),
    runId: uuid().references(() => enrichmentRuns.id, { onDelete: 'set null' }),
    createdAt: tz().notNull().defaultNow(),
  },
  (table) => [
    index('idx_website_snapshots__business_id_fetched_at').on(table.businessId, table.fetchedAt.desc()),
    // A retried step does not store the same crawl twice.
    index('idx_website_snapshots__run_id').on(table.runId),
  ],
);

/**
 * "Do not solicit us" seen on a business's website (compliance, outreach-compliance.md §3). Sticky: a later crawl that
 * misses the statement (site down, other pages read) never clears it; only a person can (`cleared_*`, BF-049), and a
 * new detection sets it again. Outreach reads this, not the latest snapshot.
 */
export const noSolicitationMarkers = pgTable('no_solicitation_markers', {
  businessId: uuid()
    .primaryKey()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  firstDetectedAt: tz().notNull(),
  lastDetectedAt: tz().notNull(),
  pageUrl: text().notNull(),
  phrases: text().array().notNull(),
  snippet: text(),
  snapshotId: uuid().references(() => websiteSnapshots.id, { onDelete: 'set null' }),
  clearedAt: tz(),
  clearedBy: uuid().references(() => user.id, { onDelete: 'set null' }),
  ...timestamps(),
});
