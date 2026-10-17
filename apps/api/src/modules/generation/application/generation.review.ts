import {
  ConflictError,
  type EngineId,
  NotFoundError,
  type QualityReport,
  QualityReportSchema,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { AuditLogger } from '../../workspace/index.ts';
import { queuePriority } from '../domain/batch.ts';
import { chainAfter } from '../domain/failover-policy.ts';
import {
  type ArtifactStore,
  ENGINE_REGISTRY,
  type EngineRegistry,
  EVENT_STREAM,
  type EventStream,
  GENERATION_ARTIFACTS,
  GENERATION_QUEUES,
  GENERATION_REPOSITORY,
  GENERATION_SETTINGS,
  type GenerationQueues,
  type GenerationRepository,
  type GenerationSettingsReader,
  SITE_HAND_OFF,
  type SiteHandOff,
  type StoredJob,
} from './ports.ts';
import { MAX_REPORTED_ISSUES, qualityReportKey } from './quality-report.ts';
import { JobTransitions } from './transitions.ts';

// What a person does with a version the gates sent to review (BF-045, for BF-046's screen): read its quality report
// and screenshots, publish it anyway with a recorded reason — never when its schema or facts failed — or ask an
// engine for a repair on the report's issues.

export interface ReviewActor {
  readonly organizationId: string;
  readonly userId: string;
}

/** The gates whose failure no person may override: a site that misstates facts or does not validate is not shown. */
const BLOCKING_GATES = new Set(['schema', 'facts']);

@Injectable()
export class GenerationReview {
  constructor(
    @Inject(GENERATION_REPOSITORY) private readonly repository: GenerationRepository,
    @Inject(ENGINE_REGISTRY) private readonly engines: EngineRegistry,
    @Inject(GENERATION_QUEUES) private readonly queues: GenerationQueues,
    @Inject(GENERATION_SETTINGS) private readonly settings: GenerationSettingsReader,
    @Inject(GENERATION_ARTIFACTS) private readonly artifacts: ArtifactStore,
    @Inject(SITE_HAND_OFF) private readonly sites: SiteHandOff,
    private readonly transitions: JobTransitions,
    private readonly audit: AuditLogger,
    @Optional() @Inject(EVENT_STREAM) private readonly stream?: EventStream,
  ) {}

  private async job(actor: ReviewActor, jobId: string): Promise<StoredJob> {
    const job = await this.repository.jobById(jobId);
    if (!job || job.organizationId !== actor.organizationId) throw new NotFoundError('GenerationJob', jobId);
    return job;
  }

  /** The quality report of the job's latest version (null when the gates have not produced one). */
  async report(actor: ReviewActor, jobId: string): Promise<QualityReport | null> {
    const job = await this.job(actor, jobId);
    if (!job.siteId || !job.resultVersionId) return null;
    const quality = await this.sites.versionQuality(actor.organizationId, job.siteId, job.resultVersionId);
    const parsed = QualityReportSchema.safeParse(quality);
    return parsed.success ? parsed.data : null;
  }

  /** One of the report's screenshots (they live in the private artifacts store). */
  async screenshot(actor: ReviewActor, jobId: string, index: number): Promise<Buffer> {
    const report = await this.report(actor, jobId);
    const shot = report?.screenshots[index];
    // The ref must be this job's: a report is data, its refs are checked before reading.
    if (!shot || !shot.ref.startsWith(`generation/${actor.organizationId}/${jobId}/quality/`))
      throw new NotFoundError('QualityScreenshot', String(index));
    const body = await this.artifacts.get(shot.ref);
    if (!body) throw new NotFoundError('QualityScreenshot', String(index));
    return body;
  }

  private async log(job: StoredJob, message: string): Promise<void> {
    const event = { type: 'log' as const, level: 'info' as const, message: message.slice(0, 2000) };
    const [seq] = await this.repository.appendEvents(job.id, null, [event]);
    if (seq !== undefined)
      await this.stream?.publish(job.id, [{ seq, event, attempt: null }]).catch(() => undefined);
  }

  /** Publishes the reviewed version anyway; refused when its schema or facts failed, or without a report. */
  async accept(actor: ReviewActor, jobId: string, reason: string): Promise<StoredJob> {
    const job = await this.job(actor, jobId);
    if (job.status !== 'needs_review' || !job.siteId || !job.resultVersionId)
      throw new ConflictError('Only a version waiting for review can be accepted.', {
        details: { reason: 'JOB_NOT_IN_REVIEW' },
      });
    const report = await this.report(actor, jobId);
    if (!report)
      throw new ConflictError('This version has no quality report: it cannot be accepted.', {
        details: { reason: 'NO_QUALITY_REPORT' },
      });
    const blocking = report.gates.filter((gate) => BLOCKING_GATES.has(gate.id) && gate.status !== 'pass');
    if (blocking.length > 0)
      throw new ConflictError('A site that fails its schema or facts checks cannot be published.', {
        details: { reason: 'ACCEPT_BLOCKED', gates: blocking.map((gate) => `${gate.id}:${gate.status}`) },
      });
    const publishedUrl = await this.sites.publishPreview({
      organizationId: actor.organizationId,
      userId: actor.userId,
      siteId: job.siteId,
      versionId: job.resultVersionId,
    });
    await this.transitions.move(job.id, 'succeeded', { publishedUrl, errorCode: null, errorMessage: null });
    await this.log(job, `Accepted after review: ${reason}`);
    await this.audit.record({
      action: 'generation.version_accepted',
      entityType: 'generation_job',
      entityId: job.id,
      metadata: { versionId: job.resultVersionId, score: report.score, reason: reason.slice(0, 500) },
    });
    await this.transitions.dispatch(job.batchId);
    return this.job(actor, jobId);
  }

  /** A repair attempt on the report's issues, asked by a person (on another engine if given). */
  async repair(actor: ReviewActor, jobId: string, engine?: EngineId): Promise<StoredJob> {
    const job = await this.job(actor, jobId);
    if (job.status !== 'needs_review')
      throw new ConflictError('Only a version waiting for review can be repaired.', {
        details: { reason: 'JOB_NOT_IN_REVIEW' },
      });
    const report = await this.report(actor, jobId);
    const issues = (report?.issues ?? []).filter((issue) => issue.repairable && !issue.platform);
    if (issues.length === 0)
      throw new ConflictError('The report has no issue an engine can repair.', {
        details: { reason: 'NOTHING_TO_REPAIR' },
      });
    const settings = await this.settings.resolve(actor.organizationId);
    const next = engine ?? job.engineCurrent;
    const candidate = this.engines.get(next);
    if (!settings.allowedEngines.includes(next) || !candidate?.capabilities.supportsRepair)
      throw new ValidationError('This engine cannot repair here.', [
        { path: ['engine'], message: 'Not allowed or cannot repair', code: 'engine' },
      ]);
    const attempts = await this.repository.attempts(job.id);
    const last = attempts.at(-1);
    if (!last?.specRef)
      throw new ConflictError('There is no site to repair.', { details: { reason: 'NO_BASE_SITE' } });
    // The repair attempt reads what to fix next to the attempt it repairs (as after the gates, BF-041).
    await this.artifacts.put(
      qualityReportKey(job.organizationId, job.id, last.attemptNo),
      Buffer.from(
        JSON.stringify({
          issues: issues
            .slice(0, MAX_REPORTED_ISSUES)
            .map((issue) => ({ ...issue, ...(issue.target?.path ? { at: issue.target.path } : {}) })),
        }),
      ),
      'application/json',
    );
    await this.transitions.move(job.id, 'repairing', {
      engineCurrent: next,
      ...(next !== job.engineCurrent
        ? {
            engineAttempts: 0,
            engineSelectionReason: 'chosen by the person (repair)',
            failoverChain: chainAfter(settings.failoverChain, next),
          }
        : {}),
      errorCode: null,
      errorMessage: null,
    });
    await this.log(job, `Repair asked after review (${issues.length} issue(s), ${next}).`);
    await this.queues.run(next, {
      jobId: job.id,
      attemptNo: job.attemptCount + 1,
      priority: queuePriority(job.priority, job.position),
    });
    return this.job(actor, jobId);
  }
}
