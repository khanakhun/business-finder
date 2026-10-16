// Site generation (BF-039): batches of jobs (one per business), each job's attempts on an engine, the ordered event
// log engines emit (streamed to the dashboard, kept 90 days) and the artifacts they leave (private bucket).

import {
  ENGINE_IDS,
  type EngineId,
  type EngineRequest,
  GENERATION_ATTEMPT_STATUSES,
  GENERATION_BATCH_STATUSES,
  GENERATION_JOB_STATUSES,
  type GenerationBatchStatus,
  type GenerationJobStatus,
  type GenerationSettings,
} from '@bf/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, orgId } from '../columns.ts';
import { organization, user } from './auth.ts';
import { businesses } from './business-graph.ts';
import { sites, siteVersions } from './sites.ts';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));
const tz = () => timestamp({ withTimezone: true });

export const generationBatches = pgTable(
  'generation_batches',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    createdBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    name: text().notNull(),
    /** Derived from its jobs and stored (lists filter on it). */
    status: text().$type<GenerationBatchStatus>().notNull().default('queued'),
    /** The workspace settings resolved when the batch was created, with the batch's own options. */
    settings: jsonb()
      .$type<GenerationSettings & { maxParallel?: number; style?: string; offer?: string }>()
      .notNull(),
    maxParallel: smallint(),
    budgetUsd: doublePrecision(),
    costUsd: doublePrecision().notNull().default(0),
    /** Jobs per status. */
    counts: jsonb().$type<Partial<Record<GenerationJobStatus, number>>>().notNull().default({}),
    idempotencyKey: text(),
    requestHash: text(),
    createdAt: tz().notNull().defaultNow(),
    startedAt: tz(),
    finishedAt: tz(),
  },
  (table) => [
    index('idx_generation_batches__organization_id_created_at').on(
      table.organizationId,
      table.createdAt.desc(),
    ),
    uniqueIndex('uq_generation_batches__organization_id_idempotency_key')
      .on(table.organizationId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    check('ck_generation_batches__status', sql`${table.status} IN (${inList(GENERATION_BATCH_STATUSES)})`),
  ],
);

export const generationJobs = pgTable(
  'generation_jobs',
  {
    id: id(),
    batchId: uuid()
      .notNull()
      .references(() => generationBatches.id, { onDelete: 'cascade' }),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    /** The site generated into (an existing one to regenerate, or the one the first success creates). */
    siteId: uuid().references(() => sites.id, { onDelete: 'set null' }),
    position: smallint().notNull(),
    /** 1 is the most urgent … 10. */
    priority: smallint().notNull(),
    engineRequested: text().$type<EngineRequest>().notNull(),
    engineCurrent: text().$type<EngineId>().notNull(),
    engineSelectionReason: text().notNull(),
    status: text().$type<GenerationJobStatus>().notNull().default('queued'),
    attemptCount: smallint().notNull().default(0),
    /** Attempts on the current engine (reset by a failover). */
    engineAttempts: smallint().notNull().default(0),
    maxAttemptsPerEngine: smallint().notNull(),
    failoverChain: jsonb().$type<EngineId[]>().notNull().default([]),
    budgetUsd: doublePrecision().notNull(),
    costUsd: doublePrecision().notNull().default(0),
    usage: jsonb().$type<{ inputTokens: number; outputTokens: number }>().notNull().default({
      inputTokens: 0,
      outputTokens: 0,
    }),
    resultVersionId: uuid().references(() => siteVersions.id, { onDelete: 'set null' }),
    publishedUrl: text(),
    qualityScore: doublePrecision(),
    errorCode: text(),
    errorMessage: text(),
    cancelRequestedAt: tz(),
    /** When the job was handed to its engine's queue (a batch releases its jobs in priority order). */
    dispatchedAt: tz(),
    createdAt: tz().notNull().defaultNow(),
    updatedAt: tz().notNull().defaultNow(),
    startedAt: tz(),
    finishedAt: tz(),
  },
  (table) => [
    index('idx_generation_jobs__organization_id_batch_id').on(table.organizationId, table.batchId),
    index('idx_generation_jobs__status').on(table.status),
    // The dispatcher: a batch's waiting jobs in priority order.
    index('idx_generation_jobs__batch_id_dispatch').on(table.batchId, table.priority, table.position),
    check('ck_generation_jobs__status', sql`${table.status} IN (${inList(GENERATION_JOB_STATUSES)})`),
    check('ck_generation_jobs__engine', sql`${table.engineCurrent} IN (${inList(ENGINE_IDS)})`),
    check('ck_generation_jobs__priority', sql`${table.priority} BETWEEN 1 AND 10`),
  ],
);

export const generationAttempts = pgTable(
  'generation_attempts',
  {
    id: id(),
    jobId: uuid()
      .notNull()
      .references(() => generationJobs.id, { onDelete: 'cascade' }),
    attemptNo: smallint().notNull(),
    engine: text().$type<EngineId>().notNull(),
    mode: text().$type<'create' | 'repair'>().notNull(),
    status: text().$type<(typeof GENERATION_ATTEMPT_STATUSES)[number]>().notNull().default('running'),
    sandboxRef: text(),
    heartbeatAt: tz().notNull().defaultNow(),
    startedAt: tz().notNull().defaultNow(),
    finishedAt: tz(),
    costUsd: doublePrecision().notNull().default(0),
    usage: jsonb().$type<{ inputTokens: number; outputTokens: number }>().notNull().default({
      inputTokens: 0,
      outputTokens: 0,
    }),
    /** The fact registry snapshot the attempt's workspace was built from (BF-040). */
    factSnapshotId: uuid(),
    /** The workspace bundle's SHA-256 (the same inputs give the same bundle). */
    bundleHash: text(),
    /** The spec the attempt produced (a `generation_artifacts` key), for the quality step. */
    specRef: text(),
    exitReason: text(),
    error: jsonb().$type<{ code: string; message: string; retryable: boolean }>(),
  },
  (table) => [
    uniqueIndex('uq_generation_attempts__job_id_attempt_no').on(table.jobId, table.attemptNo),
    // The reaper's scan: running attempts by heartbeat.
    index('idx_generation_attempts__heartbeat').on(table.heartbeatAt).where(sql`${table.status} = 'running'`),
    check('ck_generation_attempts__status', sql`${table.status} IN (${inList(GENERATION_ATTEMPT_STATUSES)})`),
    check('ck_generation_attempts__mode', sql`${table.mode} IN ('create', 'repair')`),
  ],
);

export const generationEvents = pgTable(
  'generation_events',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    jobId: uuid()
      .notNull()
      .references(() => generationJobs.id, { onDelete: 'cascade' }),
    attemptId: uuid().references(() => generationAttempts.id, { onDelete: 'cascade' }),
    /** Gapless per job: the stream's resume point (`Last-Event-ID`). */
    seq: integer().notNull(),
    type: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    createdAt: tz().notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_generation_events__job_id_seq').on(table.jobId, table.seq),
    index('idx_generation_events__created_at').on(table.createdAt),
  ],
);

export const generationArtifacts = pgTable(
  'generation_artifacts',
  {
    id: id(),
    jobId: uuid()
      .notNull()
      .references(() => generationJobs.id, { onDelete: 'cascade' }),
    attemptId: uuid().references(() => generationAttempts.id, { onDelete: 'cascade' }),
    kind: text()
      .$type<'workspace_bundle' | 'site_spec' | 'screenshot' | 'transcript' | 'log_bundle'>()
      .notNull(),
    storageKey: text().notNull(),
    sha256: text().notNull(),
    bytes: bigint({ mode: 'number' }).notNull(),
    createdAt: tz().notNull().defaultNow(),
  },
  (table) => [
    index('idx_generation_artifacts__job_id').on(table.jobId),
    uniqueIndex('uq_generation_artifacts__storage_key').on(table.storageKey),
    check(
      'ck_generation_artifacts__kind',
      sql`${table.kind} IN ('workspace_bundle', 'site_spec', 'screenshot', 'transcript', 'log_bundle')`,
    ),
  ],
);

/** A workspace's own facts about a business (BF-040): its overlay on the global registry, never shared. */
export const orgBusinessFacts = pgTable(
  'org_business_facts',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    kind: text().notNull(),
    value: jsonb().$type<unknown>().notNull(),
    locale: text(),
    note: text(),
    createdBy: uuid().references(() => user.id, { onDelete: 'set null' }),
    createdAt: tz().notNull().defaultNow(),
    updatedAt: tz().notNull().defaultNow(),
    deletedAt: tz(),
  },
  (table) => [
    index('idx_org_business_facts__organization_id_business_id')
      .on(table.organizationId, table.businessId)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

/** The registry a generation used (BF-040): deduplicated by content hash, referenced by attempts. */
export const factRegistrySnapshots = pgTable(
  'fact_registry_snapshots',
  {
    id: id(),
    organizationId: orgId().references(() => organization.id, { onDelete: 'cascade' }),
    businessId: uuid()
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    contentHash: text().notNull(),
    facts: jsonb().$type<unknown[]>().notNull(),
    stats: jsonb().$type<Record<string, unknown>>().notNull(),
    createdAt: tz().notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_fact_registry_snapshots__org_business_hash').on(
      table.organizationId,
      table.businessId,
      table.contentHash,
    ),
  ],
);
