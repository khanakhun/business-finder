import { createHash } from 'node:crypto';
import { type Clock, RateLimitedError, type ReviewSource } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import {
  type EnrichmentStep,
  type EnrichmentSubject,
  StepDeferredError,
  type StepExecution,
  StepInterruptedError,
  type StepResult,
} from '../../../enrichment/index.ts';
import { isTransient } from '../../../platform/resilience/resilience.ts';
import { SpentBeforeFailureError } from '../../application/errors.ts';
import type { ReviewSourceAdapter, ReviewSubjectReader } from '../../application/ports.ts';
import type { ReviewGates } from '../../application/review-gates.ts';
import type { ReviewMiningService } from '../../application/review-mining.service.ts';

/** An outage, a quota or a transient failure: the source is re-checked within the hour. */
function willRecover(error: unknown): boolean {
  const cause = error instanceof SpentBeforeFailureError ? error.cause : error;
  return cause instanceof RateLimitedError || isTransient(cause);
}

/** What a log line may say about an error: its class and code, never its message or payload. */
function describe(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: typeof error };
  const details = (error as { details?: { reason?: unknown } }).details;
  return {
    name: error.name,
    ...('code' in error ? { code: (error as { code: unknown }).code } : {}),
    ...(details?.reason ? { reason: details.reason } : {}),
  };
}

/** Waits for an on-demand scraper job (30–60 s each) before the step gives up on that source for this run. */
export const MAX_DEFERRALS = 20;
/** When a source that failed (outage, quota) is due again. */
const RETRY_LATER_MS = 3_600_000;

/** `gate_closed`: the source was turned off while its reviews were being analysed (nothing kept). */
type SourceOutcome = 'analysed' | 'no_reviews' | 'budget' | 'failed' | 'timed_out' | 'gate_closed';

export interface ReviewsStepOptions {
  readonly gates: Pick<ReviewGates, 'allowedSources' | 'isAllowed'>;
  readonly subjects: ReviewSubjectReader;
  readonly mining: Pick<ReviewMiningService, 'analyze' | 'observeGoldenRating'>;
  /** Fetchers per source; asynchronous ones (pending jobs) are asked first so a deferral repeats no paid call. */
  readonly adapters: readonly ReviewSourceAdapter[];
  /** Whether the workspace's monthly enrichment budget can still pay `usd`. */
  readonly canSpend: (organizationId: string, usd: number) => Promise<boolean>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly ttlDays: number;
  /** Estimated LLM cost of classifying one business's reviews. */
  readonly llmCostUsd: number;
}

/**
 * `reviews` (BF-029): for each review source the workspace's licensing gates allow, fetches the reviews
 * (transiently), anonymizes and classifies them, and merges the aggregated insights. With every gate off it skips
 * with `licensing_disabled` and reads nothing. One source failing never stops the others: it is counted and the
 * step asks for a re-check (`recheckAt`) — no transient error is rethrown while another source got through.
 */
export class ReviewsStep implements EnrichmentStep {
  readonly id = 'reviews' as const;
  readonly dependsOn = [] as const;
  readonly costCategory = 'llm' as const;
  readonly ttlDays: number;

  constructor(private readonly options: ReviewsStepOptions) {
    this.ttlDays = options.ttlDays;
  }

  appliesTo(): true {
    // Gates are per workspace: checked when the step runs (it skips with `licensing_disabled`).
    return true;
  }

  inputHash(subject: EnrichmentSubject): string {
    return createHash('sha256')
      .update(JSON.stringify({ businessId: subject.businessId, name: subject.displayName, version: 1 }))
      .digest('hex');
  }

  /**
   * Upper bound (the gates are not known at planning time): classification plus every paid source.
   * DECISION(BF-029): budgets reserve the paid Google call even where it will not run; the step books what it spent.
   */
  estimateCost(): number {
    return this.options.llmCostUsd + this.options.adapters.reduce((sum, a) => sum + a.estimatedCostUsd, 0);
  }

  /** The nightly refresh only considers reviews where a source can be fetched (pasted reviews cannot). */
  async refreshableFor(organizationId: string): Promise<boolean> {
    return (await this.options.gates.allowedSources(organizationId)).some((gate) => gate.source !== 'manual');
  }

  async execute(execution: StepExecution): Promise<StepResult> {
    const { organizationId, signal } = execution;
    const allowed = new Set<ReviewSource>(
      (await this.options.gates.allowedSources(organizationId)).map((gate) => gate.source),
    );
    const adapters = this.options.adapters.filter((adapter) => allowed.has(adapter.source));
    if (adapters.length === 0) return { outcome: 'skipped', reason: 'licensing_disabled', costUsd: 0 };
    const subject = await this.options.subjects.find(execution.subject.businessId);
    if (!subject) return { outcome: 'skipped', reason: 'not_applicable', costUsd: 0 };
    await this.options.mining.observeGoldenRating(subject);

    const outcomes: Partial<Record<ReviewSource, SourceOutcome>> = {};
    const errors: unknown[] = [];
    let spent = 0;
    let analysed = 0;
    for (const adapter of adapters) {
      if (
        adapter.estimatedCostUsd > 0 &&
        !(await this.options.canSpend(organizationId, spent + adapter.estimatedCostUsd))
      ) {
        outcomes[adapter.source] = 'budget';
        continue;
      }
      try {
        const fetched = await adapter.fetch({ organizationId, subject, signal });
        if (fetched.kind === 'pending') {
          if (execution.deferrals < MAX_DEFERRALS) {
            throw new StepDeferredError(fetched.retryAfterMs, spent, analysed > 0 ? ['review_insights'] : []);
          }
          outcomes[adapter.source] = 'timed_out';
          continue;
        }
        if (fetched.kind === 'none') {
          outcomes[adapter.source] = 'no_reviews';
          continue;
        }
        spent += fetched.batch.costUsd;
        const outcome = await this.options.mining.analyze(organizationId, subject, fetched.batch, {
          signal,
          // The gate is asked again just before storing: turned off meanwhile, nothing is kept.
          allowed: () => this.options.gates.isAllowed(organizationId, adapter.source),
        });
        spent += outcome.costUsd;
        analysed += outcome.analysed;
        outcomes[adapter.source] = outcome.dropped
          ? 'gate_closed'
          : outcome.analysed > 0
            ? 'analysed'
            : 'no_reviews';
      } catch (error) {
        if (error instanceof StepDeferredError) throw error;
        // Model batches paid before the failure are booked.
        if (error instanceof SpentBeforeFailureError) spent += error.costUsd;
        // A stop (cancel, shutdown) ends the step after booking what it spent.
        if (signal.aborted)
          throw new StepInterruptedError(error, spent, analysed > 0 ? ['review_insights'] : []);
        // Never the error itself: a model failure can carry the raw answer (review text).
        this.options.logger.warn({ source: adapter.source, error: describe(error) }, 'review source failed');
        outcomes[adapter.source] = 'failed';
        errors.push(error);
      }
    }
    // A configuration error (no model key, a refused Places key) with nothing spent and nothing analysed is shown as
    // the step's error. Anything else — outages, quotas, an LLM failure after a paid fetch — is re-checked later:
    // rethrowing would make the engine retry and pay the paid fetch again (BF-028 lesson).
    const permanent = errors.find((error) => !willRecover(error));
    if (permanent !== undefined && spent === 0 && analysed === 0) throw permanent;
    const retryLater = Object.values(outcomes).some((o) => o === 'failed' || o === 'timed_out');
    return {
      outcome: 'done',
      costUsd: spent,
      outputRef: {
        analysed,
        sources: outcomes,
        ...(retryLater
          ? { recheckAt: new Date(this.options.clock.now().getTime() + RETRY_LATER_MS).toISOString() }
          : {}),
      },
      changedFields: analysed > 0 ? ['review_insights'] : [],
    };
  }
}
