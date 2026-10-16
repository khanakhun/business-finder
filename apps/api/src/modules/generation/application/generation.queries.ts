import {
  type GenerationAttempt,
  type GenerationBatch,
  type GenerationBatchDetail,
  type GenerationBatchListQuery,
  type GenerationBatchPage,
  type GenerationEngineListing,
  type GenerationJob,
  type GenerationJobDetail,
  NotFoundError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import {
  ENGINE_REGISTRY,
  type EngineRegistry,
  GENERATION_REPOSITORY,
  type GenerationRepository,
  type StoredAttempt,
  type StoredBatch,
  type StoredJob,
} from './ports.ts';

// Read side of generation (BF-039): batches with their jobs, a job with its attempts, the engines and their load.

const iso = (date: Date | null) => (date ? date.toISOString() : null);

export const toBatch = (batch: StoredBatch): GenerationBatch => ({
  id: batch.id,
  name: batch.name,
  status: batch.status,
  maxParallel: batch.maxParallel,
  budgetUsd: batch.budgetUsd,
  costUsd: Math.round(batch.costUsd * 10_000) / 10_000,
  counts: batch.counts,
  createdBy: batch.createdBy,
  createdAt: batch.createdAt.toISOString(),
  startedAt: iso(batch.startedAt),
  finishedAt: iso(batch.finishedAt),
});

export const toJob = (job: StoredJob): GenerationJob => ({
  id: job.id,
  batchId: job.batchId,
  businessId: job.businessId as GenerationJob['businessId'],
  businessName: job.businessName,
  siteId: job.siteId as GenerationJob['siteId'],
  position: job.position,
  priority: job.priority,
  engineRequested: job.engineRequested,
  engineCurrent: job.engineCurrent,
  engineSelectionReason: job.engineSelectionReason,
  status: job.status,
  attemptCount: job.attemptCount,
  budgetUsd: job.budgetUsd,
  costUsd: Math.round(job.costUsd * 10_000) / 10_000,
  resultVersionId: job.resultVersionId,
  publishedUrl: job.publishedUrl,
  qualityScore: job.qualityScore,
  errorCode: job.errorCode,
  errorMessage: job.errorMessage,
  createdAt: job.createdAt.toISOString(),
  startedAt: iso(job.startedAt),
  finishedAt: iso(job.finishedAt),
});

const toAttempt = (attempt: StoredAttempt): GenerationAttempt => ({
  id: attempt.id,
  attemptNo: attempt.attemptNo,
  engine: attempt.engine,
  mode: attempt.mode,
  status: attempt.status,
  costUsd: attempt.costUsd,
  exitReason: attempt.exitReason,
  startedAt: attempt.startedAt.toISOString(),
  finishedAt: iso(attempt.finishedAt),
});

@Injectable()
export class GenerationQueries {
  constructor(
    @Inject(GENERATION_REPOSITORY) private readonly repository: GenerationRepository,
    @Inject(ENGINE_REGISTRY) private readonly engines: EngineRegistry,
  ) {}

  async batch(organizationId: string, batchId: string): Promise<GenerationBatchDetail> {
    const batch = await this.repository.batch(organizationId, batchId);
    if (!batch) throw new NotFoundError('GenerationBatch', batchId);
    return { ...toBatch(batch), jobs: (await this.repository.jobs(batch.id)).map(toJob) };
  }

  async batches(organizationId: string, query: GenerationBatchListQuery): Promise<GenerationBatchPage> {
    const before = query.cursor
      ? new Date(Buffer.from(query.cursor, 'base64url').toString('utf8'))
      : undefined;
    const rows = await this.repository.batches(organizationId, {
      ...(query.status ? { status: query.status } : {}),
      ...(before && !Number.isNaN(before.getTime()) ? { before } : {}),
      limit: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(toBatch),
      nextCursor:
        rows.length > query.limit && last
          ? Buffer.from(last.createdAt.toISOString()).toString('base64url')
          : null,
    };
  }

  async job(organizationId: string, jobId: string): Promise<GenerationJobDetail> {
    const job = await this.repository.job(organizationId, jobId);
    if (!job) throw new NotFoundError('GenerationJob', jobId);
    return { ...toJob(job), attempts: (await this.repository.attempts(job.id)).map(toAttempt) };
  }

  /** A job's persisted events after `afterSeq` (the SSE replay), at most 2 000. */
  async events(organizationId: string, jobId: string, afterSeq: number) {
    const job = await this.repository.job(organizationId, jobId);
    if (!job) throw new NotFoundError('GenerationJob', jobId);
    return this.repository.events(job.id, Number.isFinite(afterSeq) ? afterSeq : 0, 2_000);
  }

  async listEngines(organizationId: string): Promise<GenerationEngineListing> {
    const load = await this.repository.engineLoad(organizationId);
    return {
      items: await Promise.all(
        this.engines.list().map(async (engine) => ({
          id: engine.id,
          available: await engine.available(organizationId),
          capabilities: engine.capabilities,
          queued: load.get(engine.id)?.queued ?? 0,
          running: load.get(engine.id)?.running ?? 0,
        })),
      ),
    };
  }
}
