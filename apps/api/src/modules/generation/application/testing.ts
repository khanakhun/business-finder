import type { EngineEvent, EngineId, GenerationJobStatus } from '@bf/contracts';
import { batchStatus, type JobCounts } from '../domain/batch.ts';
import type {
  GenerationQueues,
  GenerationRepository,
  JobChanges,
  LeaseSemaphore,
  StoredAttempt,
  StoredBatch,
  StoredJob,
} from './ports.ts';

// In-memory doubles of generation's ports for unit tests (no locks: tests are sequential).

const ACTIVE: readonly GenerationJobStatus[] = ['queued', 'preparing', 'running', 'validating', 'repairing'];

export class InMemoryGenerationRepository implements GenerationRepository {
  readonly batchRows = new Map<string, StoredBatch>();
  readonly jobRows = new Map<string, StoredJob>();
  readonly attemptRows = new Map<string, StoredAttempt>();
  readonly eventRows: { jobId: string; seq: number; type: string; payload: unknown; createdAt: Date }[] = [];
  readonly artifacts: { jobId: string; attemptId: string | null; kind: string; storageKey: string }[] = [];
  readonly names = new Map<string, string>();

  async insertBatch(batch: Parameters<GenerationRepository['insertBatch']>[0]) {
    this.batchRows.set(batch.id, {
      ...batch,
      status: 'queued',
      costUsd: 0,
      counts: {},
      createdAt: new Date('2026-10-16T12:00:00Z'),
      startedAt: null,
      finishedAt: null,
    });
  }
  async insertJobs(jobs: Parameters<GenerationRepository['insertJobs']>[0]) {
    for (const job of jobs)
      this.jobRows.set(job.id, {
        ...job,
        businessName: this.names.get(job.businessId) ?? 'Business',
        status: 'queued',
        attemptCount: 0,
        engineAttempts: 0,
        costUsd: 0,
        resultVersionId: null,
        publishedUrl: null,
        qualityScore: null,
        errorCode: null,
        errorMessage: null,
        cancelRequestedAt: null,
        dispatchedAt: null,
        createdAt: new Date('2026-10-16T12:00:00Z'),
        startedAt: null,
        finishedAt: null,
      });
  }
  async batchByIdempotencyKey(organizationId: string, key: string) {
    return [...this.batchRows.values()].find(
      (b) => b.organizationId === organizationId && b.idempotencyKey === key,
    );
  }
  async batch(organizationId: string, batchId: string) {
    const batch = this.batchRows.get(batchId);
    return batch?.organizationId === organizationId ? batch : undefined;
  }
  async batchById(batchId: string) {
    return this.batchRows.get(batchId);
  }
  async batches(organizationId: string, filter: Parameters<GenerationRepository['batches']>[1]) {
    return [...this.batchRows.values()]
      .filter((b) => b.organizationId === organizationId && (!filter.status || b.status === filter.status))
      .slice(0, filter.limit);
  }
  async jobs(batchId: string) {
    return [...this.jobRows.values()]
      .filter((job) => job.batchId === batchId)
      .sort((a, b) => a.priority - b.priority || a.position - b.position);
  }
  async job(organizationId: string, jobId: string) {
    const job = this.jobRows.get(jobId);
    return job?.organizationId === organizationId ? job : undefined;
  }
  async jobById(jobId: string) {
    return this.jobRows.get(jobId);
  }
  async lockJob(jobId: string) {
    return this.jobRows.get(jobId);
  }
  async updateJob(jobId: string, changes: JobChanges) {
    const job = this.jobRows.get(jobId);
    if (job) this.jobRows.set(jobId, { ...job, ...changes });
  }
  async addCost(jobId: string, batchId: string, attemptId: string, costUsd: number) {
    const job = this.jobRows.get(jobId);
    if (job) this.jobRows.set(jobId, { ...job, costUsd: job.costUsd + costUsd });
    const attempt = this.attemptRows.get(attemptId);
    if (attempt) this.attemptRows.set(attemptId, { ...attempt, costUsd: attempt.costUsd + costUsd });
    const batch = this.batchRows.get(batchId);
    if (batch) this.batchRows.set(batchId, { ...batch, costUsd: batch.costUsd + costUsd });
  }
  async refreshBatch(batchId: string) {
    const counts: JobCounts = {};
    for (const job of await this.jobs(batchId)) counts[job.status] = (counts[job.status] ?? 0) + 1;
    const batch = this.batchRows.get(batchId);
    if (batch) this.batchRows.set(batchId, { ...batch, counts, status: batchStatus(counts) });
    return this.batchRows.get(batchId);
  }
  async insertAttempt(attempt: Parameters<GenerationRepository['insertAttempt']>[0]) {
    if (
      [...this.attemptRows.values()].some(
        (a) => a.jobId === attempt.jobId && a.attemptNo === attempt.attemptNo,
      )
    )
      return false;
    this.attemptRows.set(attempt.id, {
      ...attempt,
      status: 'running',
      heartbeatAt: new Date(),
      startedAt: new Date(),
      finishedAt: null,
      costUsd: 0,
      specRef: null,
      exitReason: null,
      error: null,
    });
    return true;
  }
  async attempt(jobId: string, attemptNo: number) {
    return [...this.attemptRows.values()].find((a) => a.jobId === jobId && a.attemptNo === attemptNo);
  }
  async attemptById(attemptId: string) {
    return this.attemptRows.get(attemptId);
  }
  async attempts(jobId: string) {
    return [...this.attemptRows.values()]
      .filter((a) => a.jobId === jobId)
      .sort((a, b) => a.attemptNo - b.attemptNo);
  }
  async finishAttempt(attemptId: string, changes: Parameters<GenerationRepository['finishAttempt']>[1]) {
    const attempt = this.attemptRows.get(attemptId);
    if (attempt?.status !== 'running') return false;
    this.attemptRows.set(attemptId, { ...attempt, ...changes });
    return true;
  }
  readonly workspaces = new Map<string, { factSnapshotId: string | null; bundleHash: string | null }>();
  async setAttemptWorkspace(
    attemptId: string,
    workspace: { factSnapshotId: string | null; bundleHash: string | null },
  ) {
    this.workspaces.set(attemptId, workspace);
  }
  async heartbeat(attemptId: string, at: Date) {
    const attempt = this.attemptRows.get(attemptId);
    if (attempt) this.attemptRows.set(attemptId, { ...attempt, heartbeatAt: at });
  }
  async staleAttempts(before: Date) {
    return [...this.attemptRows.values()].filter((a) => a.status === 'running' && a.heartbeatAt < before);
  }
  async appendEvents(jobId: string, _attemptId: string | null, events: readonly EngineEvent[]) {
    const start = this.eventRows.filter((e) => e.jobId === jobId).length + 1;
    for (const [index, event] of events.entries())
      this.eventRows.push({
        jobId,
        seq: start + index,
        type: event.type,
        payload: event,
        createdAt: new Date(),
      });
    return events.map((_, index) => start + index);
  }
  async events(jobId: string, afterSeq: number, limit: number) {
    return this.eventRows.filter((e) => e.jobId === jobId && e.seq > afterSeq).slice(0, limit);
  }
  async insertArtifact(artifact: Parameters<GenerationRepository['insertArtifact']>[0]) {
    this.artifacts.push(artifact);
  }
  async artifactKey(jobId: string, attemptId: string, kind: string) {
    const rows = this.artifacts.filter((a) => a.jobId === jobId && a.kind === kind);
    return (rows.filter((a) => a.attemptId === attemptId).at(-1) ?? rows.at(-1))?.storageKey;
  }
  async deleteEventsBefore() {
    return 0;
  }
  async trackedBusinesses(_organizationId: string, ids: readonly string[]) {
    return new Map(ids.filter((id) => this.names.has(id)).map((id) => [id, this.names.get(id) ?? '']));
  }
  async engineLoad() {
    return new Map<EngineId, { queued: number; running: number }>();
  }
  async lockBatch() {}
  async undispatched(batchId: string, limit: number) {
    return (await this.jobs(batchId))
      .filter((job) => job.status === 'queued' && !job.dispatchedAt)
      .slice(0, limit);
  }
  async inFlight(batchId: string) {
    return (await this.jobs(batchId)).filter((job) => ACTIVE.includes(job.status) && job.dispatchedAt).length;
  }
}

/** Queues that record what is enqueued (tests run the runner themselves). */
export class RecordingQueues implements GenerationQueues {
  readonly runs: {
    engine: EngineId;
    jobId: string;
    attemptNo: number;
    priority: number;
    delayMs?: number;
  }[] = [];
  readonly quality_: { jobId: string; attemptId: string }[] = [];
  readonly removed: string[] = [];
  readonly reprioritized: { jobId: string; priority: number }[] = [];
  waiting = true;
  async run(engine: EngineId, input: Parameters<GenerationQueues['run']>[1]) {
    this.runs.push({ engine, ...input });
  }
  async reprioritize(_engine: EngineId, jobId: string, _attemptNo: number, priority: number) {
    this.reprioritized.push({ jobId, priority });
    return this.waiting;
  }
  async remove(_engine: EngineId, jobId: string) {
    this.removed.push(jobId);
    return this.waiting;
  }
  async quality(input: Parameters<GenerationQueues['quality']>[0]) {
    this.quality_.push(input);
  }
}

/** Leases counted in memory (expiry ignored). */
export class InMemoryLeases implements LeaseSemaphore {
  readonly held_ = new Map<string, Set<string>>();
  private next = 0;
  async acquire(key: string, limit: number) {
    const set = this.held_.get(key) ?? new Set<string>();
    if (set.size >= limit) return null;
    const token = `t${this.next++}`;
    set.add(token);
    this.held_.set(key, set);
    return token;
  }
  async renew() {
    return true;
  }
  async release(key: string, token: string) {
    this.held_.get(key)?.delete(token);
  }
  async held(key: string) {
    return this.held_.get(key)?.size ?? 0;
  }
}
