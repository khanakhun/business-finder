import {
  type BusinessEnrichment,
  type BusinessWebsiteAudit,
  type Clock,
  ConflictError,
  ENRICHMENT_STEP_IDS,
  type EnrichmentEstimate,
  type EnrichmentRun,
  type EnrichmentStepId,
  type EnrichmentTrigger,
  NotFoundError,
  type WebsiteSnapshot,
} from '@bf/contracts';
import { afterCommit, type DbClient } from '@bf/db';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { WorkspaceDefaults } from '../../workspace/index.ts';
import type { EnrichmentSubject, StepOutput } from '../domain/enrichment-step.ts';
import { isFresh, type Plan, planRun } from '../domain/planner.ts';
import {
  ENRICHMENT_QUEUE,
  ENRICHMENT_REPOSITORY,
  type EnrichmentQueue,
  type EnrichmentRepository,
  NO_SOLICITATION_MARKERS,
  type NoSolicitationMarkers,
  type RunRecord,
  type StepRecord,
  SUBJECT_READER,
  type SubjectReader,
  WEBSITE_SNAPSHOTS,
  type WebsiteSnapshotRepository,
} from './ports.ts';
import { StepRegistry } from './step-registry.ts';
import { WebsiteAuditService } from './website-audit.service.ts';

export interface StartRunInput {
  readonly organizationId: string;
  readonly businessId: string;
  readonly requestedBy: string | null;
  readonly trigger: EnrichmentTrigger;
  readonly steps?: readonly EnrichmentStepId[];
  readonly force: boolean;
  readonly idempotencyKey?: string | null;
  /** Run only the requested steps and what they strictly need (no optional dependencies). */
  readonly withoutOptionalDependencies?: boolean;
}

export type StartOutcome =
  | { readonly kind: 'started' | 'existing'; readonly run: RunRecord }
  | { readonly kind: 'rejected'; readonly reason: 'not_found' | 'budget' | 'nothing_to_do' | 'busy' };

/** Open runs a workspace may have at once (a runaway bulk or loop cannot fill the queue for everyone). */
export const MAX_OPEN_RUNS_PER_ORG = 1_000;

const iso = (date: Date | null) => date?.toISOString() ?? null;

interface PlanOptions {
  readonly steps?: readonly EnrichmentStepId[];
  readonly force: boolean;
  readonly remaining: number | null;
  readonly withoutOptionalDependencies?: boolean;
}

export function toRunView(run: RunRecord, steps: readonly StepRecord[]): EnrichmentRun {
  return {
    id: run.id,
    businessId: run.businessId,
    trigger: run.trigger,
    requestedSteps: [...run.requestedSteps],
    force: run.force,
    status: run.status,
    costUsd: run.costUsd,
    error: run.error,
    steps: [...steps]
      .sort((a, b) => ENRICHMENT_STEP_IDS.indexOf(a.step) - ENRICHMENT_STEP_IDS.indexOf(b.step))
      .map((s) => ({
        id: s.id,
        step: s.step,
        status: s.status,
        attempt: s.attempt,
        costUsd: s.costUsd,
        skipReason: s.skipReason,
        error: s.error,
        startedAt: iso(s.startedAt),
        finishedAt: iso(s.finishedAt),
      })),
    createdAt: run.createdAt.toISOString(),
    startedAt: iso(run.startedAt),
    finishedAt: iso(run.finishedAt),
  };
}

/**
 * Plans with what the business looks like, what earlier runs produced and what is left of the workspace's
 * monthly budget.
 */
@Injectable()
export class EnrichmentPlanning {
  constructor(
    @Inject(ENRICHMENT_REPOSITORY) private readonly runs: EnrichmentRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly registry: StepRegistry,
    private readonly defaults: WorkspaceDefaults,
  ) {}

  async remainingUsd(
    organizationId: string,
  ): Promise<{ budget: number | null; spent: number; remaining: number | null }> {
    const { monthlyBudgetUsd } = await this.defaults.enrichmentSettings(organizationId);
    const spent = await this.runs.monthSpendUsd(organizationId, this.clock.now());
    return {
      budget: monthlyBudgetUsd,
      spent,
      remaining: monthlyBudgetUsd === null ? null : Math.max(0, monthlyBudgetUsd - spent),
    };
  }

  /**
   * Whether the workspace's monthly budget can still pay `usd` from what was actually spent (a guard around paid
   * calls inside a running step: estimates already reserved the run's share).
   */
  async canSpend(organizationId: string, usd: number): Promise<boolean> {
    const { monthlyBudgetUsd } = await this.defaults.enrichmentSettings(organizationId);
    if (monthlyBudgetUsd === null) return true;
    const spent = await this.runs.monthSpendUsd(organizationId, this.clock.now(), { actualOnly: true });
    return spent + usd <= monthlyBudgetUsd + 1e-9;
  }

  async plan(subject: EnrichmentSubject, options: PlanOptions): Promise<Plan> {
    return this.planWith(subject, await this.runs.latestOutputs(subject.businessId), options);
  }

  planWith(
    subject: EnrichmentSubject,
    last: ReadonlyMap<EnrichmentStepId, StepOutput>,
    options: PlanOptions,
  ): Plan {
    return planRun({
      ...(options.steps ? { requested: options.steps } : {}),
      steps: this.registry.all(),
      subject,
      last,
      force: options.force,
      now: this.clock.now(),
      remainingUsd: options.remaining,
      ...(options.withoutOptionalDependencies ? { withoutOptionalDependencies: true } : {}),
    });
  }
}

/**
 * Starts an enrichment run (manual, bulk, discovery, schedule): idempotent on the request key, one open run per
 * business and workspace (a second request joins it), only for businesses the workspace tracks. Interactive runs
 * are created even when every step is fresh (the run says so); automatic ones are not.
 */
@Injectable()
export class StartEnrichmentCommand {
  constructor(
    @Inject(ENRICHMENT_REPOSITORY) private readonly runs: EnrichmentRepository,
    @Inject(SUBJECT_READER) private readonly subjects: SubjectReader,
    @Inject(ENRICHMENT_QUEUE) private readonly queue: EnrichmentQueue,
    @Inject(DB_CLIENT) private readonly db: DbClient,
    private readonly planning: EnrichmentPlanning,
  ) {}

  async execute(input: StartRunInput): Promise<StartOutcome> {
    if (input.idempotencyKey) {
      const existing = await this.runs.findByIdempotencyKey(input.organizationId, input.idempotencyKey);
      if (existing) return this.replay(existing, input);
    }
    if (!(await this.subjects.tracks(input.organizationId, input.businessId))) {
      return { kind: 'rejected', reason: 'not_found' };
    }
    const subject = await this.subjects.subject(input.businessId);
    if (!subject) return { kind: 'rejected', reason: 'not_found' };
    return this.create(input, subject);
  }

  /** A key already used: the same request gets its run back; another business with the same key is a conflict. */
  private replay(existing: RunRecord, input: StartRunInput): StartOutcome {
    if (existing.businessId !== input.businessId) {
      throw new ConflictError('This Idempotency-Key was used for another business.', {
        details: { reason: 'IDEMPOTENCY_KEY_REUSED' },
      });
    }
    return { kind: 'existing', run: existing };
  }

  /**
   * Under the workspace lock: the monthly budget, the open-run cap and "one open run per business" are read and
   * reserved together (concurrent bulk, discovery and nightly starts cannot overspend).
   */
  @Transactional()
  private async create(input: StartRunInput, subject: EnrichmentSubject): Promise<StartOutcome> {
    await this.runs.lockOrganization(input.organizationId);
    if (input.idempotencyKey) {
      const raced = await this.runs.findByIdempotencyKey(input.organizationId, input.idempotencyKey);
      if (raced) return this.replay(raced, input);
    }
    const open = await this.runs.findOpenRun(input.organizationId, input.businessId);
    if (open) return { kind: 'existing', run: open };
    if ((await this.runs.countOpenRuns(input.organizationId)) >= MAX_OPEN_RUNS_PER_ORG) {
      return { kind: 'rejected', reason: 'busy' };
    }
    const { remaining } = await this.planning.remainingUsd(input.organizationId);
    const plan = await this.planning.plan(subject, {
      ...(input.steps ? { steps: input.steps } : {}),
      force: input.force,
      remaining,
      ...(input.withoutOptionalDependencies ? { withoutOptionalDependencies: true } : {}),
    });
    const interactive = input.trigger === 'manual';
    if (!interactive && !plan.steps.some((s) => s.status === 'queued')) {
      const budget = plan.steps.some((s) => s.skipReason === 'budget');
      return { kind: 'rejected', reason: budget ? 'budget' : 'nothing_to_do' };
    }
    const run = await this.runs.createRun(
      {
        businessId: input.businessId,
        organizationId: input.organizationId,
        requestedBy: input.requestedBy,
        trigger: input.trigger,
        requestedSteps: input.steps ?? plan.steps.map((s) => s.step),
        force: input.force,
        estimatedUsd: plan.estimatedUsd,
        idempotencyKey: input.idempotencyKey ?? null,
      },
      plan.steps,
    );
    await afterCommit(this.db, () => this.queue.start(run.id, run.organizationId, run.trigger));
    return { kind: 'started', run };
  }
}

/** `POST /v1/enrichment/estimate`: what a bulk enrichment would run and cost, against the monthly budget. */
@Injectable()
export class EstimateEnrichmentQuery {
  constructor(
    @Inject(SUBJECT_READER) private readonly subjects: SubjectReader,
    @Inject(ENRICHMENT_REPOSITORY) private readonly runs: EnrichmentRepository,
    private readonly planning: EnrichmentPlanning,
  ) {}

  async execute(
    organizationId: string,
    input: {
      readonly businessIds: readonly string[];
      readonly steps?: readonly EnrichmentStepId[];
      readonly force: boolean;
    },
  ): Promise<EnrichmentEstimate> {
    const totals = new Map<EnrichmentStepId, { willRun: number; skipped: number; costUsd: number }>();
    let totalCostUsd = 0;
    // A few queries for the whole selection (tracked subjects, their latest outputs, the budget), then pure plans.
    const subjects = await this.subjects.trackedSubjects(organizationId, input.businessIds);
    const outputs = await this.runs.latestOutputsMany(subjects.map((s) => s.businessId));
    for (const subject of subjects) {
      const plan = this.planning.planWith(subject, outputs.get(subject.businessId) ?? new Map(), {
        ...(input.steps ? { steps: input.steps } : {}),
        force: input.force,
        remaining: null,
      });
      for (const step of plan.steps) {
        const total = totals.get(step.step) ?? { willRun: 0, skipped: 0, costUsd: 0 };
        if (step.status === 'queued') {
          total.willRun += 1;
          total.costUsd += step.estimatedUsd;
        } else {
          total.skipped += 1;
        }
        totals.set(step.step, total);
      }
      totalCostUsd += plan.estimatedUsd;
    }
    const budget = await this.planning.remainingUsd(organizationId);
    return {
      businesses: subjects.length,
      steps: [...totals.entries()]
        .sort(([a], [b]) => ENRICHMENT_STEP_IDS.indexOf(a) - ENRICHMENT_STEP_IDS.indexOf(b))
        .map(([step, total]) => ({ step, ...total, costUsd: round(total.costUsd) })),
      totalCostUsd: round(totalCostUsd),
      budget: {
        monthlyBudgetUsd: budget.budget,
        spentUsd: round(budget.spent),
        remainingUsd: budget.remaining,
      },
      withinBudget: budget.remaining === null || totalCostUsd <= budget.remaining,
    };
  }
}

const round = (usd: number) => Math.round(usd * 1_000_000) / 1_000_000;

/** Read side: runs, where each step stands for a business, the latest website snapshot. */
@Injectable()
export class EnrichmentQueries {
  constructor(
    @Inject(ENRICHMENT_REPOSITORY) private readonly runs: EnrichmentRepository,
    @Inject(SUBJECT_READER) private readonly subjects: SubjectReader,
    @Inject(WEBSITE_SNAPSHOTS) private readonly snapshots: WebsiteSnapshotRepository,
    @Inject(NO_SOLICITATION_MARKERS) private readonly markers: NoSolicitationMarkers,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly registry: StepRegistry,
    private readonly audits: WebsiteAuditService,
  ) {}

  /** The audit of the latest crawl (BF-030), or null before the first audit; `none` without a website. */
  async websiteAudit(organizationId: string, businessId: string): Promise<BusinessWebsiteAudit> {
    await this.assertTracked(organizationId, businessId);
    const audit = await this.audits.latest(businessId);
    const subject = await this.subjects.subject(businessId);
    return {
      status: subject?.websiteUrl ? (audit?.websiteStatus ?? null) : 'none',
      audit: audit
        ? {
            id: audit.id,
            businessId: audit.businessId,
            snapshotId: audit.snapshotId,
            psi: audit.psi,
            vision: audit.vision,
            findings: audit.findings,
            qualityScore: audit.qualityScore,
            websiteStatus: audit.websiteStatus,
            createdAt: audit.createdAt.toISOString(),
            updatedAt: audit.updatedAt.toISOString(),
          }
        : null,
    };
  }

  async run(organizationId: string, runId: string): Promise<EnrichmentRun> {
    const run = await this.runs.findRun(runId);
    if (!run || run.organizationId !== organizationId) throw new NotFoundError('EnrichmentRun', runId);
    return toRunView(run, await this.runs.steps(runId));
  }

  async business(organizationId: string, businessId: string): Promise<BusinessEnrichment> {
    await this.assertTracked(organizationId, businessId);
    const latest = await this.runs.latestRun(organizationId, businessId);
    const outputs = await this.runs.latestOutputs(businessId);
    const subject = await this.subjects.subject(businessId);
    const now = this.clock.now();
    return {
      latestRun: latest ? toRunView(latest, await this.runs.steps(latest.id)) : null,
      steps: ENRICHMENT_STEP_IDS.map((id) => {
        const step = this.registry.get(id);
        const last = outputs.get(id);
        return {
          step: id,
          registered: step !== undefined,
          lastDoneAt: iso(last?.finishedAt ?? null),
          fresh: Boolean(step && subject && isFresh(step, last, step.inputHash(subject), now)),
        };
      }),
    };
  }

  async website(organizationId: string, businessId: string): Promise<WebsiteSnapshot> {
    await this.assertTracked(organizationId, businessId);
    const snapshot = await this.snapshots.latest(businessId);
    if (!snapshot) throw new NotFoundError('WebsiteSnapshot', businessId);
    const intel = snapshot.intel;
    const marker = await this.markers.find(businessId);
    return {
      id: snapshot.id,
      businessId,
      url: snapshot.url,
      finalUrl: intel.finalUrl,
      httpStatus: intel.httpStatus,
      fetchedAt: snapshot.fetchedAt.toISOString(),
      reachability: intel.reachability,
      socialOnly: intel.socialOnly,
      tls: intel.tls,
      security: intel.security,
      languages: intel.languages,
      pages: intel.pages.map(({ markdownKey: _key, ...page }) => page),
      contacts: intel.contacts,
      socials: intel.socials,
      booking: intel.booking,
      ordering: intel.ordering,
      chat: intel.chat,
      analytics: intel.analytics,
      tech: intel.tech,
      freshness: intel.freshness,
      mobile: intel.mobile,
      performanceHints: intel.performanceHints,
      noSolicitation: intel.noSolicitation,
      logoCandidates: intel.logoCandidates,
      imageCandidates: intel.imageCandidates,
      screenshots: {
        desktop: intel.screenshots.desktopKey !== null,
        mobile: intel.screenshots.mobileKey !== null,
      },
      noSolicitationMarker:
        marker && marker.clearedAt === null
          ? {
              firstDetectedAt: marker.firstDetectedAt.toISOString(),
              lastDetectedAt: marker.lastDetectedAt.toISOString(),
              pageUrl: marker.pageUrl,
              phrases: [...marker.phrases],
              snippet: marker.snippet,
            }
          : null,
    };
  }

  /** The object key of a screenshot of the latest snapshot (served by the controller). */
  async screenshotKey(
    organizationId: string,
    businessId: string,
    kind: 'desktop' | 'mobile',
  ): Promise<string> {
    await this.assertTracked(organizationId, businessId);
    const snapshot = await this.snapshots.latest(businessId);
    const key =
      kind === 'desktop' ? snapshot?.intel.screenshots.desktopKey : snapshot?.intel.screenshots.mobileKey;
    // Only this business's crawl artifacts (`sites/<businessId>/…`), whatever a stored key says.
    if (!key?.startsWith(`sites/${businessId}/`) || key.split('/').includes('..')) {
      throw new NotFoundError('Screenshot', businessId);
    }
    return key;
  }

  private async assertTracked(organizationId: string, businessId: string): Promise<void> {
    if (!(await this.subjects.tracks(organizationId, businessId)))
      throw new NotFoundError('Business', businessId);
  }
}
