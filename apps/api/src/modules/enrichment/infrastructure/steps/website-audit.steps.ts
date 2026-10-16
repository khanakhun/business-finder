import { createHash } from 'node:crypto';
import {
  type Clock,
  ExternalServiceError,
  PSI_STRATEGIES,
  type PsiStrategyResult,
  RateLimitedError,
} from '@bf/contracts';
import type { Logger } from '@bf/observability';
import type { RateLimiter } from '../../../platform/rate-limit/valkey-rate-limiter.ts';
import { isTransient } from '../../../platform/resilience/resilience.ts';
import type {
  PageSpeedPort,
  VisionGrader,
  WebsiteAuditRecord,
  WebsiteSnapshotRecord,
  WebsiteSnapshotRepository,
} from '../../application/ports.ts';
import type { WebsiteAuditService } from '../../application/website-audit.service.ts';
import {
  type EnrichmentStep,
  type EnrichmentSubject,
  StepDeferredError,
  type StepExecution,
  type StepResult,
} from '../../domain/enrichment-step.ts';

// The website audit steps (BF-030): `psi` (PageSpeed Insights, mobile + desktop) and `vision_audit` (vision grade of
// the crawl's screenshots). Both write their part of the snapshot's audit, which recomputes findings, score and
// status. Neither rethrows an outage or a quota: the part is left out and the step asks for a re-check within the
// hour (an engine retry would loop, BF-028 lesson); only configuration errors (a refused key, no model key) fail it.

const RETRY_LATER_MS = 3_600_000;
/** Waits for the PageSpeed per-minute bucket before giving up for this run (re-checked later). */
export const PSI_MAX_DEFERRALS = 10;

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A crawl the audit can measure: a live page of the business (not parked, broken or a social profile). */
const measurable = (snapshot: WebsiteSnapshotRecord) =>
  !snapshot.intel.socialOnly &&
  (snapshot.intel.reachability === 'ok' || snapshot.intel.reachability === 'redirected');

/** The snapshot the crawl of this run (or a fresh earlier one) produced, else the business's latest. */
async function snapshotFor(
  execution: StepExecution,
  snapshots: Pick<WebsiteSnapshotRepository, 'byId' | 'latest'>,
): Promise<WebsiteSnapshotRecord | undefined> {
  const id = execution.dependencies.get('site_intel')?.outputRef?.snapshotId;
  const byId = typeof id === 'string' ? await snapshots.byId(id) : undefined;
  return byId && byId.businessId === execution.subject.businessId
    ? byId
    : snapshots.latest(execution.subject.businessId);
}

const done = (
  audit: WebsiteAuditRecord,
  costUsd: number,
  extra: Record<string, unknown> = {},
): StepResult => ({
  outcome: 'done',
  costUsd,
  outputRef: {
    auditId: audit.id,
    websiteStatus: audit.websiteStatus,
    qualityScore: audit.qualityScore,
    ...extra,
  },
  changedFields: ['website_audit'],
});

/** Errors that will not fix themselves and say something about our setup (shown as the step's error). */
const isConfigurationError = (error: unknown) =>
  !isTransient(error) &&
  !(error instanceof RateLimitedError) &&
  !(error instanceof ExternalServiceError && error.details?.reason === 'PAGE_FAILED');

export interface PsiStepOptions {
  readonly snapshots: Pick<WebsiteSnapshotRepository, 'byId' | 'latest'>;
  readonly pagespeed: PageSpeedPort;
  readonly audits: Pick<WebsiteAuditService, 'record'>;
  /** The workspace's PageSpeed key (vault, else the deployment's), or none (anonymous quota). */
  readonly key: (organizationId: string) => Promise<string | undefined>;
  readonly limiter: Pick<RateLimiter, 'tryTake'>;
  readonly quota: { readonly perMinute: number; readonly perDay: number };
  readonly clock: Clock;
  readonly logger: Logger;
  readonly ttlDays: number;
}

export class PsiStep implements EnrichmentStep {
  readonly id = 'psi' as const;
  readonly dependsOn = ['site_intel'] as const;
  readonly costCategory = 'provider' as const;
  readonly ttlDays: number;

  constructor(private readonly options: PsiStepOptions) {
    this.ttlDays = options.ttlDays;
  }

  appliesTo(subject: EnrichmentSubject): true | 'no_website' {
    return subject.websiteUrl ? true : 'no_website';
  }

  inputHash(subject: EnrichmentSubject): string {
    return hash({ step: 'psi', url: subject.websiteUrl });
  }

  /** The API is free (within its quota). */
  estimateCost(): number {
    return 0;
  }

  async execute(execution: StepExecution): Promise<StepResult> {
    const snapshot = await snapshotFor(execution, this.options.snapshots);
    if (!snapshot) return { outcome: 'skipped', reason: 'not_applicable', costUsd: 0 };
    if (!measurable(snapshot))
      return done(await this.options.audits.record(snapshot, {}), 0, { measured: false });

    const key = await this.options.key(execution.organizationId);
    const wait = await this.takeQuota(key);
    if (wait > 0) {
      if (execution.deferrals < PSI_MAX_DEFERRALS) throw new StepDeferredError(wait, 0);
      const audit = await this.options.audits.record(snapshot, {});
      return done(audit, 0, { measured: false, quota: true, recheckAt: this.later() });
    }
    const url = snapshot.intel.finalUrl ?? snapshot.url;
    const results: Partial<Record<(typeof PSI_STRATEGIES)[number], PsiStrategyResult>> = {};
    const errors: unknown[] = [];
    for (const strategy of PSI_STRATEGIES) {
      try {
        results[strategy] = await this.options.pagespeed.run(url, strategy, {
          key,
          signal: execution.signal,
        });
      } catch (error) {
        if (execution.signal.aborted) throw error;
        this.options.logger.warn({ strategy, error: describe(error) }, 'PageSpeed run failed');
        errors.push(error);
      }
    }
    const measured = Object.keys(results).length > 0;
    const configuration = errors.find(isConfigurationError);
    if (!measured && configuration !== undefined) throw configuration;
    const audit = await this.options.audits.record(
      snapshot,
      measured ? { psi: { mobile: results.mobile ?? null, desktop: results.desktop ?? null } } : {},
    );
    // A strategy that failed on an outage or a quota is measured again within the hour.
    const retry = errors.some((error) => !isConfigurationError(error) && !isPageFailure(error));
    return done(audit, 0, { measured, ...(retry ? { recheckAt: this.later() } : {}) });
  }

  /** Two runs' worth from the per-minute and per-day buckets of the key; the wait in ms when empty. */
  private async takeQuota(key: string | undefined): Promise<number> {
    const bucket = `psi:${key ? hash(key).slice(0, 16) : 'anonymous'}`;
    const { perMinute, perDay } = this.options.quota;
    for (const [suffix, capacity, perSecond] of [
      ['minute', perMinute, perMinute / 60],
      ['day', perDay, perDay / 86_400],
    ] as const) {
      for (let run = 0; run < PSI_STRATEGIES.length; run++) {
        const wait = await this.options.limiter.tryTake(`${bucket}:${suffix}`, { capacity, perSecond });
        if (wait > 0) return wait;
      }
    }
    return 0;
  }

  private later(): string {
    return new Date(this.options.clock.now().getTime() + RETRY_LATER_MS).toISOString();
  }
}

const isPageFailure = (error: unknown) =>
  error instanceof ExternalServiceError && error.details?.reason === 'PAGE_FAILED';

/** What a log line may say about an error: class, code and reason, never its message or payload. */
function describe(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: typeof error };
  const details = (error as { details?: { reason?: unknown } }).details;
  return {
    name: error.name,
    ...('code' in error ? { code: (error as { code: unknown }).code } : {}),
    ...(details?.reason ? { reason: details.reason } : {}),
  };
}

export interface VisionAuditStepOptions {
  readonly snapshots: Pick<WebsiteSnapshotRepository, 'byId' | 'latest'>;
  readonly grader: VisionGrader;
  readonly audits: Pick<WebsiteAuditService, 'record' | 'categoryLabel'>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly ttlDays: number;
  /** Estimated cost of one grade (smart-tier vision, two screenshots), for budgets. */
  readonly costUsd: number;
}

export class VisionAuditStep implements EnrichmentStep {
  readonly id = 'vision_audit' as const;
  readonly dependsOn = ['site_intel', 'psi'] as const;
  /** After PageSpeed (the audit is then complete when this step ends), whatever PageSpeed's outcome. */
  readonly optionalDependencies = ['psi'] as const;
  readonly costCategory = 'llm' as const;
  readonly ttlDays: number;

  constructor(private readonly options: VisionAuditStepOptions) {
    this.ttlDays = options.ttlDays;
  }

  appliesTo(subject: EnrichmentSubject): true | 'no_website' {
    return subject.websiteUrl ? true : 'no_website';
  }

  inputHash(subject: EnrichmentSubject): string {
    return hash({ step: 'vision_audit', url: subject.websiteUrl });
  }

  estimateCost(): number {
    return this.options.costUsd;
  }

  async execute(execution: StepExecution): Promise<StepResult> {
    const snapshot = await snapshotFor(execution, this.options.snapshots);
    if (!snapshot) return { outcome: 'skipped', reason: 'not_applicable', costUsd: 0 };
    if (!measurable(snapshot))
      return done(await this.options.audits.record(snapshot, {}), 0, { graded: false });
    try {
      const graded = await this.options.grader.grade(
        execution.organizationId,
        snapshot,
        {
          displayName: execution.subject.displayName,
          categoryLabel: await this.options.audits.categoryLabel(snapshot.businessId),
        },
        execution.signal,
      );
      if (!graded) return done(await this.options.audits.record(snapshot, {}), 0, { graded: false });
      return done(await this.options.audits.record(snapshot, { vision: graded.grade }), graded.costUsd, {
        graded: true,
      });
    } catch (error) {
      if (execution.signal.aborted || isConfigurationError(error)) throw error;
      // The model is down or answered badly: the audit goes on without the grade, which is retried within the hour.
      this.options.logger.warn({ error: describe(error) }, 'vision grade failed');
      const audit = await this.options.audits.record(snapshot, {});
      return done(audit, 0, {
        graded: false,
        recheckAt: new Date(this.options.clock.now().getTime() + RETRY_LATER_MS).toISOString(),
      });
    }
  }
}
