import type {
  DiscoveryIntent,
  DiscoveryRunOptions,
  MultiPolygon,
  ProviderId,
  ProviderQuery,
  RunCounts,
  RunEndReason,
  RunStatus,
  SourceRecordInput,
  TaskStatus,
} from '@bf/contracts';

// Ports of discovery runs (BF-020).

export interface RunRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly createdBy: string | null;
  readonly intent: DiscoveryIntent;
  readonly areaId: string | null;
  readonly areaGeometry: MultiPolygon;
  readonly providers: readonly ProviderId[];
  readonly options: DiscoveryRunOptions;
  readonly status: RunStatus;
  readonly reason: RunEndReason | null;
  readonly budgetUsd: number;
  readonly costUsd: number;
  readonly reservedUsd: number;
  readonly budgetExhausted: boolean;
  readonly counts: RunCounts;
  readonly ingestsPending: number;
  readonly requestHash: string | null;
  readonly plannedAt: Date | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
}

export interface TaskRecord {
  readonly id: string;
  readonly runId: string;
  readonly parentTaskId: string | null;
  readonly provider: ProviderId;
  readonly categoryId: string | null;
  readonly query: ProviderQuery;
  readonly depth: number;
  readonly status: TaskStatus;
  readonly attempt: number;
  readonly records: number;
  readonly saturated: boolean;
  readonly costUsd: number;
  readonly notBefore: Date | null;
  readonly error: string | null;
  readonly createdAt: Date;
}

export interface NewRun {
  readonly organizationId: string;
  readonly createdBy: string | null;
  readonly intent: DiscoveryIntent;
  readonly areaId: string | null;
  readonly areaGeometry: MultiPolygon;
  readonly providers: readonly ProviderId[];
  readonly options: DiscoveryRunOptions;
  readonly budgetUsd: number;
  readonly idempotencyKey: string | null;
  readonly requestHash: string | null;
}

export interface NewTask {
  readonly provider: ProviderId;
  readonly categoryId: string | null;
  readonly query: ProviderQuery;
  readonly depth: number;
  readonly parentTaskId: string | null;
  readonly dedupeKey: string;
  readonly notBefore?: Date | null;
}

export interface FetchOutcome {
  readonly records: readonly SourceRecordInput[];
  readonly saturated: boolean;
  readonly costUsd: number;
}

export interface IngestCounts {
  readonly created: number;
  readonly merged: number;
  readonly unchanged: number;
  readonly possibleDuplicates: number;
  readonly failedRecords: number;
}

/** Keyset page: `next` resumes after the last item (`at` only for lists not ordered by id). */
export interface Page<T> {
  readonly items: T[];
  readonly next: { readonly id: string; readonly at?: string } | null;
}

/** Position to resume after (UUIDv7 ids are time-ordered; `at` is a microsecond timestamp string). */
export interface After {
  readonly id: string;
  readonly at?: string;
}

export interface RunBusinessRow {
  readonly businessId: string;
  readonly name: string;
  readonly primaryCategoryId: string | null;
  readonly locality: string | null;
  /** ISO-8601 UTC with microseconds. */
  readonly trackedAt: string;
}

export interface DiscoveryRunRepository {
  /** Idempotent on (workspace, idempotency key): an existing run is returned with `created: false`. */
  createRun(run: NewRun): Promise<{ readonly run: RunRecord; readonly created: boolean }>;
  findByIdempotencyKey(organizationId: string, key: string): Promise<RunRecord | undefined>;
  /** Queued or running runs of the workspace; serializes concurrent starts (call inside a transaction). */
  activeRunCount(organizationId: string): Promise<number>;
  getRun(id: string, organizationId?: string): Promise<RunRecord | undefined>;
  listRuns(
    organizationId: string,
    filter: { readonly status?: RunStatus; readonly limit: number; readonly after?: After },
  ): Promise<Page<RunRecord>>;
  /** queued → running (false when the run is not queued). */
  startRun(runId: string, now: Date): Promise<boolean>;
  /**
   * Inserts the tasks not already planned (dedupe key) and counts them; returns the new ones. Nothing is added
   * to a run that is no longer running. `planned` marks the run planned in the same transaction.
   */
  addTasks(
    runId: string,
    tasks: readonly NewTask[],
    options?: { readonly planned?: boolean },
  ): Promise<TaskRecord[]>;
  getTask(taskId: string): Promise<TaskRecord | undefined>;
  /** queued → running with a heartbeat and attempt + 1; undefined when someone else has it or it is finished. */
  claimTask(taskId: string, now: Date): Promise<TaskRecord | undefined>;
  /** Reserves `amount` of the run budget for the task's call if it fits (atomic, held on the task); false otherwise. */
  reserve(task: TaskRecord, amount: number): Promise<boolean>;
  /** Gives the task's reservation back to the run (no-op when it holds none). */
  releaseReservation(task: TaskRecord): Promise<void>;
  /** Keeps a running task from looking abandoned while its call is slow. */
  heartbeat(taskId: string, now: Date): Promise<void>;
  /**
   * running → done in one transaction with its follow-up tasks (child tiles, next page): records wait on the task
   * for ingestion; run cost, counters and pending ingests updated; the reservation is released. When the run
   * ended meanwhile (cancelled), the task is skipped instead and only the cost is recorded (`accepted: false`).
   */
  completeTask(
    task: TaskRecord,
    outcome: FetchOutcome,
    followUps: readonly NewTask[],
  ): Promise<{ readonly accepted: boolean; readonly created: TaskRecord[] }>;
  /** running → failed (final): counted on the run. */
  failTask(task: TaskRecord, error: string): Promise<void>;
  /** running → queued, for a retry (BullMQ attempt or reconciler). */
  requeueTask(taskId: string): Promise<void>;
  /** queued/running → skipped (budget, cancellation, result cap). */
  skipTask(task: TaskRecord, error: string | null): Promise<boolean>;
  /** Skips every queued task of the run; returns how many. */
  skipQueued(runId: string, error: string): Promise<number>;
  markStop(runId: string, reason: RunEndReason): Promise<void>;
  pendingRecords(taskId: string): Promise<SourceRecordInput[] | undefined>;
  /** Once per task (idempotent): clears its records and adds the counts to the run. */
  applyIngest(task: TaskRecord, counts: IngestCounts): Promise<boolean>;
  /** Ends a running run with no open work (locked; idempotent). Returns the run if this call ended it. */
  finalize(runId: string, now: Date): Promise<RunRecord | undefined>;
  /** queued/running → cancelled; queued tasks skipped. Returns the run and its running tasks, if it changed. */
  cancel(
    runId: string,
    organizationId: string,
    now: Date,
  ): Promise<{ run: RunRecord; running: TaskRecord[] } | undefined>;
  // Reconciliation (ADR-0006: the database is the source of truth, queues are rebuilt from it).
  staleRunningTasks(before: Date, limit: number): Promise<TaskRecord[]>;
  queuedTasksOlderThan(before: Date, limit: number): Promise<TaskRecord[]>;
  tasksAwaitingIngest(before: Date, limit: number): Promise<TaskRecord[]>;
  runningRunsWithoutOpenWork(limit: number): Promise<string[]>;
  /** Queued runs, and running runs whose planning never committed, older than `before`. */
  unplannedRunsOlderThan(before: Date, limit: number): Promise<string[]>;
  listTasks(
    runId: string,
    filter: { readonly limit: number; readonly after?: After },
  ): Promise<Page<TaskRecord>>;
  runBusinesses(
    organizationId: string,
    runId: string,
    filter: { readonly limit: number; readonly after?: After },
  ): Promise<Page<RunBusinessRow>>;
}
export const DISCOVERY_RUN_REPOSITORY = Symbol('DiscoveryRunRepository');

/** Execution queues (BullMQ); producers derive job ids from idempotency keys. */
export interface RunQueue {
  plan(runId: string, organizationId: string, attemptKey?: string): Promise<void>;
  /** `attemptKey` (reconciler) gives a fresh job when an earlier one with the same id failed or was lost. */
  fetch(task: TaskRecord, organizationId: string, delayMs?: number, attemptKey?: string): Promise<void>;
  ingest(runId: string, taskId: string, organizationId: string, attemptKey?: string): Promise<void>;
  /** Asks running fetch jobs of these tasks to stop (cooperative cancellation). */
  cancelFetches(tasks: readonly TaskRecord[]): Promise<void>;
}
export const RUN_QUEUE = Symbol('RunQueue');

/** Realtime progress (throttled) and completion. */
export interface RunProgress {
  /** At most one realtime update per run per second (the run is loaded only when one is due). */
  progressed(runId: string): Promise<void>;
  finished(run: RunRecord): Promise<void>;
}
export const RUN_PROGRESS = Symbol('RunProgress');
