import type {
  EngineCapabilities,
  EngineEvent,
  EngineId,
  EngineRequest,
  GenerationBatchStatus,
  GenerationJobStatus,
  GenerationSettings,
} from '@bf/contracts';
import type { Logger } from '@bf/observability';

// Ports of the generation module (BF-039). Engines (BF-041, BF-044), the workspace preparer (BF-040) and the quality
// pipeline (BF-045) plug in here; this ticket ships a fake engine, a fixture preparer and a schema-only pipeline.

/** What an engine receives for one attempt. */
export interface EngineRunContext {
  readonly jobId: string;
  readonly attemptNo: number;
  readonly mode: 'create' | 'repair';
  readonly organizationId: string;
  readonly workspace: { readonly bundleRef: string; readonly path?: string };
  readonly brief: WorkspaceSummary;
  readonly budgetUsd: number;
  readonly deadlineAt: Date;
  readonly locales: readonly string[];
  readonly repair?: { readonly baseSpecRef: string; readonly issues: readonly unknown[] };
  readonly logger: Logger;
  /** Stores the attempt's site spec (JSON); the `done` event names the returned ref. */
  readonly writeSpec: (spec: unknown) => Promise<string>;
}

export interface AgentEngine {
  readonly id: EngineId;
  readonly capabilities: EngineCapabilities;
  /** Whether it can run for the workspace now (a key, a healthy sandbox host…). */
  available(organizationId: string): Promise<boolean>;
  /** Streams the attempt's events; ends with `done` or `error`. Stops promptly when `signal` aborts. */
  run(ctx: EngineRunContext, signal: AbortSignal): AsyncIterable<EngineEvent>;
}

export interface EngineRegistry {
  list(): readonly AgentEngine[];
  get(id: EngineId): AgentEngine | undefined;
}
export const ENGINE_REGISTRY = Symbol('EngineRegistry');

/** What the brief says about the site to write (selection and the engine's context). */
export interface WorkspaceSummary {
  readonly businessName: string;
  readonly pages: number;
  readonly items: number;
  readonly locales: readonly string[];
}

/** Builds an attempt's workspace (BF-040: brief, facts, assets); here a fixture. */
export interface WorkspacePreparer {
  prepare(job: StoredJob): Promise<{ readonly bundleRef: string; readonly summary: WorkspaceSummary }>;
  /** Without building it: what selection needs (pages, items, languages). */
  estimate(
    job: Pick<StoredJob, 'organizationId' | 'businessId'>,
    locales: readonly string[],
  ): Promise<WorkspaceSummary>;
}
export const WORKSPACE_PREPARER = Symbol('WorkspacePreparer');

export interface QualityResult {
  readonly outcome: 'pass' | 'repair' | 'needs_review';
  readonly score: number;
  readonly issues: readonly unknown[];
}

/** The quality gates of a result (BF-045); here the schema validator only. */
export interface QualityPipeline {
  evaluate(input: {
    readonly job: StoredJob;
    readonly spec: unknown;
    readonly repairsLeft: number;
    readonly supportsRepair: boolean;
  }): Promise<QualityResult>;
}
export const QUALITY_PIPELINE = Symbol('QualityPipeline');

export interface StoredBatch {
  readonly id: string;
  readonly organizationId: string;
  readonly createdBy: string | null;
  readonly name: string;
  readonly status: GenerationBatchStatus;
  readonly settings: GenerationSettings & { maxParallel?: number; style?: string; offer?: string };
  readonly maxParallel: number | null;
  readonly budgetUsd: number | null;
  readonly costUsd: number;
  readonly counts: Partial<Record<GenerationJobStatus, number>>;
  readonly idempotencyKey: string | null;
  readonly requestHash: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

export interface StoredJob {
  readonly id: string;
  readonly batchId: string;
  readonly organizationId: string;
  readonly businessId: string;
  readonly businessName: string;
  readonly siteId: string | null;
  readonly position: number;
  readonly priority: number;
  readonly engineRequested: EngineRequest;
  readonly engineCurrent: EngineId;
  readonly engineSelectionReason: string;
  readonly status: GenerationJobStatus;
  readonly attemptCount: number;
  readonly engineAttempts: number;
  readonly maxAttemptsPerEngine: number;
  readonly failoverChain: EngineId[];
  readonly budgetUsd: number;
  readonly costUsd: number;
  readonly resultVersionId: string | null;
  readonly publishedUrl: string | null;
  readonly qualityScore: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly cancelRequestedAt: Date | null;
  readonly dispatchedAt: Date | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

export interface StoredAttempt {
  readonly id: string;
  readonly jobId: string;
  readonly attemptNo: number;
  readonly engine: EngineId;
  readonly mode: 'create' | 'repair';
  readonly status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly heartbeatAt: Date;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly costUsd: number;
  readonly specRef: string | null;
  readonly exitReason: string | null;
  readonly error: { code: string; message: string; retryable: boolean } | null;
}

export type JobChanges = Partial<
  Pick<
    StoredJob,
    | 'status'
    | 'siteId'
    | 'priority'
    | 'engineRequested'
    | 'engineCurrent'
    | 'engineSelectionReason'
    | 'attemptCount'
    | 'engineAttempts'
    | 'failoverChain'
    | 'costUsd'
    | 'resultVersionId'
    | 'publishedUrl'
    | 'qualityScore'
    | 'errorCode'
    | 'errorMessage'
    | 'cancelRequestedAt'
    | 'dispatchedAt'
    | 'startedAt'
    | 'finishedAt'
  >
>;

export interface GenerationRepository {
  insertBatch(
    batch: Omit<StoredBatch, 'status' | 'costUsd' | 'counts' | 'createdAt' | 'startedAt' | 'finishedAt'>,
  ): Promise<void>;
  insertJobs(
    jobs: readonly Omit<
      StoredJob,
      | 'businessName'
      | 'status'
      | 'attemptCount'
      | 'engineAttempts'
      | 'costUsd'
      | 'resultVersionId'
      | 'publishedUrl'
      | 'qualityScore'
      | 'errorCode'
      | 'errorMessage'
      | 'cancelRequestedAt'
      | 'dispatchedAt'
      | 'createdAt'
      | 'startedAt'
      | 'finishedAt'
    >[],
  ): Promise<void>;
  batchByIdempotencyKey(organizationId: string, key: string): Promise<StoredBatch | undefined>;
  batch(organizationId: string, batchId: string): Promise<StoredBatch | undefined>;
  batchById(batchId: string): Promise<StoredBatch | undefined>;
  batches(
    organizationId: string,
    filter: { readonly status?: GenerationBatchStatus; readonly before?: Date; readonly limit: number },
  ): Promise<StoredBatch[]>;
  jobs(batchId: string): Promise<StoredJob[]>;
  job(organizationId: string, jobId: string): Promise<StoredJob | undefined>;
  jobById(jobId: string): Promise<StoredJob | undefined>;
  /** Locks the job row until the transaction ends (transitions are serialized). */
  lockJob(jobId: string): Promise<StoredJob | undefined>;
  updateJob(jobId: string, changes: JobChanges): Promise<void>;
  /** Adds an attempt's cost to its job and batch. */
  addCost(
    jobId: string,
    batchId: string,
    attemptId: string,
    costUsd: number,
    usage: { inputTokens: number; outputTokens: number },
  ): Promise<void>;
  /** Recomputes and stores a batch's counts and derived status; returns it. */
  refreshBatch(batchId: string, now: Date): Promise<StoredBatch | undefined>;
  insertAttempt(
    attempt: Pick<StoredAttempt, 'id' | 'jobId' | 'attemptNo' | 'engine' | 'mode'>,
  ): Promise<boolean>;
  attempt(jobId: string, attemptNo: number): Promise<StoredAttempt | undefined>;
  attemptById(attemptId: string): Promise<StoredAttempt | undefined>;
  attempts(jobId: string): Promise<StoredAttempt[]>;
  finishAttempt(
    attemptId: string,
    changes: Pick<StoredAttempt, 'status' | 'exitReason'> &
      Partial<Pick<StoredAttempt, 'specRef' | 'error'>> & { finishedAt: Date },
  ): Promise<boolean>;
  heartbeat(attemptId: string, at: Date): Promise<void>;
  /** Running attempts whose heartbeat is older than `before`. */
  staleAttempts(before: Date, limit: number): Promise<StoredAttempt[]>;
  /** Appends events with the next sequence numbers of the job (gapless); returns the numbers given. */
  appendEvents(jobId: string, attemptId: string | null, events: readonly EngineEvent[]): Promise<number[]>;
  events(
    jobId: string,
    afterSeq: number,
    limit: number,
  ): Promise<{ seq: number; type: string; payload: unknown; createdAt: Date }[]>;
  insertArtifact(artifact: {
    jobId: string;
    attemptId: string | null;
    kind: string;
    storageKey: string;
    sha256: string;
    bytes: number;
  }): Promise<void>;
  deleteEventsBefore(before: Date, limit: number): Promise<number>;
  /** Tracked businesses of the workspace among `ids`, with their names. */
  trackedBusinesses(organizationId: string, ids: readonly string[]): Promise<Map<string, string>>;
  /** Serializes the batch's dispatching until the transaction ends (an advisory lock). */
  lockBatch(batchId: string): Promise<void>;
  /** Jobs of a batch waiting to be handed to their queues, in priority order. */
  undispatched(batchId: string, limit: number): Promise<StoredJob[]>;
  /** Jobs of a batch handed to their queues and not settled yet. */
  inFlight(batchId: string): Promise<number>;
  /** Jobs per engine: waiting (queued, dispatched) and running, for this workspace and overall. */
  engineLoad(organizationId: string): Promise<Map<EngineId, { queued: number; running: number }>>;
}
export const GENERATION_REPOSITORY = Symbol('GenerationRepository');

/** Counting semaphores with leases (Valkey): workspace-per-engine slots and the sandbox pool. */
export interface LeaseSemaphore {
  /** A lease on one of `limit` slots of `key`, held `ttlMs` unless renewed; null when none is free. */
  acquire(key: string, limit: number, ttlMs: number): Promise<string | null>;
  renew(key: string, token: string, ttlMs: number): Promise<boolean>;
  release(key: string, token: string): Promise<void>;
  /** Leases held now. */
  held(key: string): Promise<number>;
}
export const LEASE_SEMAPHORE = Symbol('LeaseSemaphore');

/** The engine queues and the quality queue. */
export interface GenerationQueues {
  run(
    engine: EngineId,
    input: { jobId: string; attemptNo: number; priority: number; delayMs?: number; wait?: number },
  ): Promise<void>;
  /** Moves a waiting run to another priority (live reprioritization); false when it is not waiting. */
  reprioritize(engine: EngineId, jobId: string, attemptNo: number, priority: number): Promise<boolean>;
  /** Removes a waiting run (a cancelled or re-routed job); false when it is not waiting. */
  remove(engine: EngineId, jobId: string, attemptNo: number): Promise<boolean>;
  quality(input: { jobId: string; attemptId: string; organizationId: string }): Promise<void>;
}
export const GENERATION_QUEUES = Symbol('GenerationQueues');

/** Asks a running attempt to stop (any process); the runner polls it. */
export interface CancelSignals {
  request(jobId: string): Promise<void>;
  watch(jobId: string): { readonly signal: AbortSignal; stop(): void };
}
export const CANCEL_SIGNALS = Symbol('CancelSignals');

/** Live events for the dashboard (Valkey stream per job; the SSE endpoint tails it in part 2). */
export interface EventStream {
  publish(jobId: string, entries: readonly { seq: number; event: EngineEvent }[]): Promise<void>;
}
export const EVENT_STREAM = Symbol('EventStream');

/** Private storage of attempts' artifacts (specs, workspace bundles). */
export interface ArtifactStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | undefined>;
}
export const GENERATION_ARTIFACTS = Symbol('GenerationArtifacts');

/** The workspace's monthly AI budget (BF-013). */
export interface WorkspaceBudget {
  check(organizationId: string): Promise<'ok' | 'soft' | 'hard'>;
}
export const WORKSPACE_BUDGET = Symbol('WorkspaceBudget');

/** The sites module: a result becomes a version, and maybe a preview. */
export interface SiteHandOff {
  /** A new version of the job's site (the site created when there is none); returns ids. */
  createVersion(input: {
    readonly organizationId: string;
    readonly userId: string | null;
    readonly businessId: string;
    readonly siteId: string | null;
    readonly spec: Record<string, unknown>;
    readonly jobId: string;
    readonly changeSummary: string;
  }): Promise<{ readonly siteId: string; readonly versionId: string }>;
  publishPreview(input: {
    readonly organizationId: string;
    readonly userId: string | null;
    readonly siteId: string;
    readonly versionId: string;
  }): Promise<string | null>;
}
export const SITE_HAND_OFF = Symbol('SiteHandOff');

/** Deployment-wide generation limits. */
export interface GenerationLimits {
  readonly maxSandboxes: number;
  /** Attempts whose heartbeat is older are presumed dead (the reaper). */
  readonly heartbeatTimeoutMs: number;
  readonly heartbeatEveryMs: number;
  /** An attempt's wall time. */
  readonly attemptTimeoutMs: number;
  /** A job waiting for a slot tries again after about this long. */
  readonly slotRetryMs: number;
  /** The largest site spec an attempt may produce. */
  readonly maxSpecBytes: number;
}
export const GENERATION_LIMITS = Symbol('GenerationLimits');

/** The workspace's generation settings (BF-039 defaults; a settings screen comes with BF-046). */
export interface GenerationSettingsReader {
  resolve(organizationId: string): Promise<GenerationSettings>;
}
export const GENERATION_SETTINGS = Symbol('GenerationSettings');
