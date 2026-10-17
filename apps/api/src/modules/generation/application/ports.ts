import type {
  BriefOverrides,
  EngineCapabilities,
  EngineEvent,
  EngineId,
  EngineRequest,
  GenerationBatchStatus,
  GenerationJobStatus,
  GenerationSettings,
  QualityReport,
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
  /** What is left of the job's budget for this attempt. */
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
  prepare(job: StoredJob): Promise<{
    readonly bundleRef: string;
    readonly summary: WorkspaceSummary;
    /** The bundle's SHA-256 and size (BF-040), and the registry snapshot it was built from. */
    readonly bundleHash?: string;
    readonly bytes?: number;
    readonly factSnapshotId?: string;
  }>;
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
  /** The candidate after safe auto-fixes (the version to create), when it differs from the input. */
  readonly spec?: unknown;
  /** The full report (BF-045), stored once on the version. */
  readonly report?: QualityReport;
}

/** The quality gates of a result (BF-045). */
export interface QualityPipeline {
  evaluate(input: {
    readonly job: StoredJob;
    readonly spec: unknown;
    readonly repairsLeft: number;
    readonly supportsRepair: boolean;
    /** The attempt whose result this is (its workspace bundle holds the job's registry snapshot). */
    readonly attemptId?: string;
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
  /** The person's adjustments to the brief (BF-040). */
  readonly briefOverrides: BriefOverrides | null;
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
  /** The workspace's jobs, newest first (BF-046: the review queue, a business's Sites tab). */
  listJobs(
    organizationId: string,
    filter: {
      readonly status?: GenerationJobStatus;
      readonly businessId?: string;
      /** Keyset: strictly after this job in the order (created at, then id, both descending). */
      readonly after?: { readonly createdAt: Date; readonly id: string };
      readonly limit: number;
    },
  ): Promise<StoredJob[]>;
  /** A job's stored artifacts, newest first, with their attempt's number. */
  jobArtifacts(jobId: string): Promise<StoredArtifact[]>;
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
  /** What the attempt's workspace was built from (BF-040). */
  setAttemptWorkspace(
    attemptId: string,
    workspace: { factSnapshotId: string | null; bundleHash: string | null },
  ): Promise<void>;
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
  /** A job's events after `afterSeq`, with the attempt each belongs to (null: not an attempt's, e.g. a review). */
  events(
    jobId: string,
    afterSeq: number,
    limit: number,
  ): Promise<{ seq: number; type: string; payload: unknown; attemptNo: number | null; createdAt: Date }[]>;
  insertArtifact(artifact: {
    jobId: string;
    attemptId: string | null;
    kind: string;
    storageKey: string;
    sha256: string;
    bytes: number;
  }): Promise<void>;
  /**
   * The storage key of an attempt's artifact of a kind — its workspace bundle: the job's registry snapshot. Bundles
   * are content-addressed, so an attempt that reused its job's bundle has no row of its own: the job's latest then.
   */
  artifactKey(jobId: string, attemptId: string, kind: string): Promise<string | undefined>;
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
  /** `attempt`: the attempt the events belong to (BF-046 groups the console by attempt). */
  publish(
    jobId: string,
    entries: readonly { seq: number; event: EngineEvent; attempt: number | null }[],
  ): Promise<void>;
  /** The job's new status on its stream (the SSE endpoint closes once it is settled). */
  status(jobId: string, status: GenerationJobStatus): Promise<void>;
}

/** Throttled updates for the dashboard on the workspace's realtime channel (not domain events). */
export interface LiveUpdates {
  job(job: StoredJob): Promise<void>;
  batch(batch: StoredBatch): Promise<void>;
}
export const LIVE_UPDATES = Symbol('LiveUpdates');

/** Metrics of the orchestration (the infrastructure records them; tests leave them out). */
export interface GenerationTelemetry {
  leaseWait(engine: EngineId): void;
  queueWait(engine: EngineId, seconds: number): void;
  phase(engine: EngineId, phase: 'prepare' | 'run', seconds: number): void;
  sandboxes(held: number): void;
  settled(job: StoredJob, outcome: GenerationJobStatus): void;
}
export const GENERATION_TELEMETRY = Symbol('GenerationTelemetry');

/** The quality gates' measures (BF-045): gate outcomes, decisions, scores, costs and platform problems. */
export interface QualityTelemetry {
  evaluated(engine: EngineId, report: QualityReport): void;
}
export const QUALITY_TELEMETRY = Symbol('QualityTelemetry');
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
  /** A version's stored quality report (null when it has none; BF-045). */
  versionQuality(organizationId: string, siteId: string, versionId: string): Promise<unknown>;
  /** Stores the quality report on the version (set once; BF-045). */
  recordQuality(input: {
    readonly organizationId: string;
    readonly siteId: string;
    readonly versionId: string;
    readonly report: QualityReport;
  }): Promise<void>;
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
export interface StoredArtifact {
  readonly id: string;
  readonly kind: string;
  readonly attemptNo: number | null;
  readonly storageKey: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly createdAt: Date;
}

/** Reads a workspace bundle's files (the infrastructure's zstd-compressed tar). */
export type BundleUnpacker = (bundle: Buffer) => Map<string, Buffer>;
export const BUNDLE_UNPACKER = Symbol('BundleUnpacker');

export interface GenerationSettingsReader {
  resolve(organizationId: string): Promise<GenerationSettings>;
}
export const GENERATION_SETTINGS = Symbol('GenerationSettings');
