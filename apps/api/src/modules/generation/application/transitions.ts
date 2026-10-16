import {
  type Clock,
  GenerationBatchCompleted,
  type GenerationJobStatus,
  GenerationJobStatusChanged,
  NotFoundError,
} from '@bf/contracts';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { EventRecorder } from '../../platform/events/event-recorder.ts';
import { queuePriority } from '../domain/batch.ts';
import { assertTransition } from '../domain/job-state-machine.ts';
import {
  ENGINE_REGISTRY,
  type EngineRegistry,
  EVENT_STREAM,
  type EventStream,
  GENERATION_QUEUES,
  GENERATION_REPOSITORY,
  type GenerationQueues,
  type GenerationRepository,
  type JobChanges,
  LIVE_UPDATES,
  type LiveUpdates,
  type StoredJob,
} from './ports.ts';

// Job transitions (BF-039): every status change is checked against the state machine on the locked row, recorded
// as `generation.job.status_changed` (outbox) and folded into the batch's counts. The dispatcher hands a batch's
// jobs to their engine queues in priority order, at most `maxParallel` at a time when the batch sets it.

/** A hook run when a job settles (the module counts outcomes and costs there). */
export const SETTLED_HOOK = Symbol('GenerationSettledHook');

const SETTLED: readonly GenerationJobStatus[] = ['succeeded', 'needs_review', 'failed', 'cancelled'];

@Injectable()
export class JobTransitions {
  constructor(
    @Inject(GENERATION_REPOSITORY) private readonly repository: GenerationRepository,
    @Inject(GENERATION_QUEUES) private readonly queues: GenerationQueues,
    @Inject(ENGINE_REGISTRY) private readonly engines: EngineRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly events: EventRecorder,
    @Optional() @Inject(EVENT_STREAM) private readonly stream?: EventStream | null,
    @Optional() @Inject(LIVE_UPDATES) private readonly live?: LiveUpdates | null,
    @Optional()
    @Inject(SETTLED_HOOK)
    private readonly onSettled?: ((job: StoredJob, to: GenerationJobStatus) => void) | null,
  ) {}

  /** Moves the job to `to` (refused when the machine forbids it), with other changes; returns the job before. */
  @Transactional()
  async move(jobId: string, to: GenerationJobStatus, changes: JobChanges = {}): Promise<StoredJob> {
    const job = await this.repository.lockJob(jobId);
    if (!job) throw new NotFoundError('GenerationJob', jobId);
    assertTransition(job.status, to);
    const now = this.clock.now();
    await this.repository.updateJob(jobId, {
      ...changes,
      status: to,
      ...(to === 'preparing' && !job.startedAt ? { startedAt: now } : {}),
      ...(SETTLED.includes(to) ? { finishedAt: now } : to === 'queued' ? { finishedAt: null } : {}),
    });
    await this.events.record(GenerationJobStatusChanged, {
      orgId: job.organizationId,
      payload: {
        jobId,
        batchId: job.batchId,
        businessId: job.businessId,
        from: job.status,
        to,
        engine: changes.engineCurrent ?? job.engineCurrent,
        siteId: changes.siteId ?? job.siteId,
        versionId: changes.resultVersionId ?? job.resultVersionId,
        publishedUrl: changes.publishedUrl ?? job.publishedUrl,
      },
    });
    const before = await this.repository.batchById(job.batchId);
    const batch = await this.repository.refreshBatch(job.batchId, now);
    const ended = (status: string | undefined) =>
      status === 'completed' || status === 'completed_with_issues' || status === 'cancelled';
    if (batch && ended(batch.status) && !ended(before?.status)) {
      await this.events.record(GenerationBatchCompleted, {
        orgId: job.organizationId,
        payload: {
          batchId: batch.id,
          createdBy: batch.createdBy,
          status: batch.status,
          succeeded: batch.counts.succeeded ?? 0,
          total: Object.values(batch.counts).reduce((sum, n) => sum + (n ?? 0), 0),
        },
      });
    }
    // Live views follow (best effort: the dashboard refetches on reconnect).
    const after = await this.repository.jobById(jobId);
    await this.stream?.status(jobId, to).catch(() => undefined);
    if (after) await this.live?.job(after).catch(() => undefined);
    if (batch) await this.live?.batch(batch).catch(() => undefined);
    if (SETTLED.includes(to) && after) this.onSettled?.(after, to);
    return job;
  }

  /**
   * Hands the batch's waiting jobs to their queues: all of them, or as many as `maxParallel` leaves room for, in
   * priority order. Called when a batch starts and whenever one of its jobs settles.
   */
  @Transactional()
  async dispatch(batchId: string): Promise<number> {
    // One dispatcher per batch at a time: two jobs settling together never release more than `maxParallel`.
    await this.repository.lockBatch(batchId);
    const batch = await this.repository.batchById(batchId);
    if (!batch) return 0;
    const room =
      batch.maxParallel === null ? 50 : batch.maxParallel - (await this.repository.inFlight(batchId));
    if (room <= 0) return 0;
    const next = await this.repository.undispatched(batchId, room);
    for (const job of next) {
      await this.repository.updateJob(job.id, { dispatchedAt: this.clock.now() });
      await this.queues.run(job.engineCurrent, {
        jobId: job.id,
        attemptNo: job.attemptCount + 1,
        priority: queuePriority(job.priority, job.position),
      });
    }
    return next.length;
  }

  /** Whether the engine exists here (registered). */
  engine(id: StoredJob['engineCurrent']) {
    return this.engines.get(id);
  }
}
