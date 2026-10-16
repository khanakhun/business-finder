import { createHash } from 'node:crypto';
import type { Clock, ReviewSource } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import {
  type EnrichmentStep,
  type EnrichmentSubject,
  StepDeferredError,
  type StepExecution,
  StepInterruptedError,
  type StepResult,
} from '../../../enrichment/index.ts';
import type { ReviewSourceAdapter, ReviewSubjectReader } from '../../application/ports.ts';
import type { ReviewGates } from '../../application/review-gates.ts';
import type { ReviewMiningService } from '../../application/review-mining.service.ts';

/** Waits for an on-demand scraper job (30–60 s each) before the step gives up on that source for this run. */
export const MAX_DEFERRALS = 20;
/** When a source that failed (outage, quota) is due again. */
const RETRY_LATER_MS = 3_600_000;

type SourceOutcome = 'analysed' | 'no_reviews' | 'budget' | 'failed' | 'timed_out';

export interface ReviewsStepOptions {
  readonly gates: Pick<ReviewGates, 'allowedSources'>;
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
        const fetched = await adapter.fetch({
          organizationId,
          subject,
          signal,
          attemptKey: execution.stepRowId,
        });
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
        const outcome = await this.options.mining.analyze(organizationId, subject, fetched.batch, { signal });
        spent += outcome.costUsd;
        analysed += outcome.analysed;
        outcomes[adapter.source] = outcome.analysed > 0 ? 'analysed' : 'no_reviews';
      } catch (error) {
        if (error instanceof StepDeferredError) throw error;
        // A stop (cancel, shutdown) ends the step after booking what it spent.
        if (signal.aborted)
          throw new StepInterruptedError(error, spent, analysed > 0 ? ['review_insights'] : []);
        this.options.logger.warn({ err: error, source: adapter.source }, 'review source failed');
        outcomes[adapter.source] = 'failed';
        errors.push(error);
      }
    }
    const failed = Object.values(outcomes).filter((o) => o === 'failed').length;
    // Every source failed: the engine retries (bounded attempts) or reports the error — nothing got through.
    if (failed > 0 && failed === adapters.length) {
      throw spent > 0 ? new StepInterruptedError(errors[0], spent) : errors[0];
    }
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
