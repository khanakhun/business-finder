import type { EnrichmentCostCategory, EnrichmentSkipReason, EnrichmentStepId } from '@bf/contracts';

// The step plugin contract (BF-027, Strategy/Plugin): the engine plans, schedules, retries, meters and records;
// a step only says what it needs, whether it applies, what it costs and how to run. Later tickets (email
// verification, reviews, PageSpeed, visual audit) add steps by registering one — never by changing the engine.

/** What a step knows about the business before it runs (from the golden record). */
export interface EnrichmentSubject {
  readonly businessId: string;
  readonly displayName: string;
  readonly websiteUrl: string | null;
  readonly countryCode: string | null;
  readonly locales: readonly string[];
  readonly emails: readonly string[];
}

/** A finished step of an earlier run (or of this run): what freshness and dependents read. */
export interface StepOutput {
  readonly finishedAt: Date;
  readonly inputHash: string | null;
  /**
   * Pointers to what the step produced (snapshot ids, artifact keys), never page content. An ISO `recheckAt` makes
   * the output stale at that time for the nightly refresh (and the step's `isStale`).
   */
  readonly outputRef: Readonly<Record<string, unknown>> | null;
}

export interface StepExecution {
  readonly runId: string;
  readonly stepRowId: string;
  /** The workspace that asked (cost attribution, ingestion org context). */
  readonly organizationId: string;
  readonly subject: EnrichmentSubject;
  readonly inputHash: string;
  /** Latest outputs of the steps this one depends on (from this run, or fresh ones it did not repeat). */
  readonly dependencies: ReadonlyMap<EnrichmentStepId, StepOutput>;
  /** Aborted when the run is cancelled or the job's lock is lost. */
  readonly signal: AbortSignal;
  /** Times this step already deferred itself (StepDeferredError). */
  readonly deferrals: number;
}

export type StepResult =
  | {
      readonly outcome: 'done';
      readonly costUsd: number;
      readonly outputRef: Readonly<Record<string, unknown>>;
      /** Golden-record fields the step changed (reported in `business.enriched`). */
      readonly changedFields: readonly string[];
    }
  | { readonly outcome: 'skipped'; readonly reason: EnrichmentSkipReason; readonly costUsd: number };

/** A shared token bucket the engine takes from before running the step (provider quotas). */
export interface StepRateLimit {
  readonly key: string;
  readonly capacity: number;
  readonly perSecond: number;
}

export interface EnrichmentStep {
  readonly id: EnrichmentStepId;
  readonly dependsOn: readonly EnrichmentStepId[];
  /**
   * Dependencies (among `dependsOn`) that only order this step: it runs after them whatever their outcome — a
   * skipped or failed one never skips it (e.g. e-mails known without a website are still verified).
   */
  readonly optionalDependencies?: readonly EnrichmentStepId[];
  readonly costCategory: EnrichmentCostCategory;
  /** Days an output stays fresh (configuration). */
  readonly ttlDays: number;
  readonly rateLimit?: StepRateLimit;
  /** `true`, or why the step does not apply to this business (`no_website`, `not_applicable`). */
  appliesTo(subject: EnrichmentSubject): true | EnrichmentSkipReason;
  /** What the step reads, hashed: idempotency (`businessId:step:inputHash`) and freshness. */
  inputHash(subject: EnrichmentSubject): string;
  /** Estimated cost in USD (budgets are checked against estimates before running). */
  estimateCost(subject: EnrichmentSubject): number;
  /** Overrides the TTL rule when a step knows better (e.g. an output older than its source). */
  isStale?(last: StepOutput, now: Date): boolean;
  execute(execution: StepExecution): Promise<StepResult>;
}

/** What a step spent and changed before it stopped early (booked on the step and its run whatever happens next). */
export interface StepSpend {
  readonly costUsd: number;
  readonly changedFields: readonly string[];
}

/**
 * Thrown by a step that has to wait (a mail server's politeness bucket is empty): the engine puts it back in the queue
 * for `retryAfterMs` without using an attempt, after booking what it already spent and changed. Work done before stays
 * done — a step must make re-running safe (BF-028). Steps bound their own deferrals (`StepExecution.deferrals`).
 */
export class StepDeferredError extends Error implements StepSpend {
  constructor(
    readonly retryAfterMs: number,
    readonly costUsd: number,
    readonly changedFields: readonly string[] = [],
    message = 'Step deferred',
  ) {
    super(message);
    this.name = 'StepDeferredError';
  }
}

/**
 * Wraps the error that stopped a step after it had spent money or changed facts (a paid check, then a failure): the
 * engine books the spend, then handles `cause` as usual (retry, wait, fail) — so a retry served from a cache never
 * hides a cost (BF-028).
 */
export class StepInterruptedError extends Error implements StepSpend {
  constructor(
    override readonly cause: unknown,
    readonly costUsd: number,
    readonly changedFields: readonly string[] = [],
  ) {
    super('Step interrupted', { cause });
    this.name = 'StepInterruptedError';
  }
}
