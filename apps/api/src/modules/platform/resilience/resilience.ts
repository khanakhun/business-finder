import { DomainError } from '@bf/contracts';
import {
  ConsecutiveBreaker,
  circuitBreaker,
  ExponentialBackoff,
  handleWhen,
  type IPolicy,
  retry,
  TimeoutStrategy,
  timeout,
  wrap,
} from 'cockatiel';

export interface ResiliencePolicyConfig {
  /** Per-attempt timeout. */
  readonly timeoutMs: number;
  /** Retries after the first attempt (exponential backoff with jitter). */
  readonly maxRetries: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  /** Consecutive failures that open the circuit, and how long it stays open before a trial call. */
  readonly breakerThreshold: number;
  readonly halfOpenAfterMs: number;
}

/**
 * Named policies for external dependencies (coding-standards §1). Each adapter picks one by name; tune here.
 * Feature tickets add entries (`google-places`, `pagespeed`, `gmail`, …).
 */
export const RESILIENCE_POLICIES = {
  default: {
    timeoutMs: 10_000,
    maxRetries: 2,
    initialDelayMs: 200,
    maxDelayMs: 5_000,
    breakerThreshold: 5,
    halfOpenAfterMs: 30_000,
  },
  /**
   * The site renderer's revalidation (BF-035): an internal call, short; its job retries with backoff while the
   * renderer is down, so one quick retry here is enough.
   */
  'sites-revalidate': {
    timeoutMs: 5_000,
    maxRetries: 1,
    initialDelayMs: 300,
    maxDelayMs: 1_000,
    breakerThreshold: 5,
    halfOpenAfterMs: 30_000,
  },
  /** External geocoders (BF-017): short, few retries — users wait for location resolution. */
  geocoder: {
    timeoutMs: 8_000,
    maxRetries: 1,
    initialDelayMs: 500,
    maxDelayMs: 2_000,
    breakerThreshold: 5,
    halfOpenAfterMs: 60_000,
  },
  /** Open-data queries in intel (BF-019): a first extract for an area downloads from the dataset's bucket. */
  'intel-open-data': {
    // Longer than intel's own budget (OPEN_DATA_QUERY_TIMEOUT_SECONDS, 120 s) so intel answers first, and no
    // retry: a timed-out extract retried would build twice.
    timeoutMs: 135_000,
    maxRetries: 0,
    initialDelayMs: 1_000,
    maxDelayMs: 5_000,
    breakerThreshold: 5,
    halfOpenAfterMs: 60_000,
  },
  /**
   * Website crawls in intel (BF-026/BF-027): intel's own deadline is the request's `timeoutSeconds` (90 s), so it
   * answers first. No retry here: the enrichment engine retries the step (with backoff) and keeps the breaker
   * open across steps while intel is down.
   */
  'intel-site': {
    timeoutMs: 120_000,
    maxRetries: 0,
    initialDelayMs: 1_000,
    maxDelayMs: 5_000,
    breakerThreshold: 5,
    halfOpenAfterMs: 60_000,
  },
  /** Stock photo APIs (BF-038: Unsplash, Pexels): quick searches, one retry; their quotas are guarded apart. */
  stock: {
    timeoutMs: 10_000,
    maxRetries: 1,
    initialDelayMs: 500,
    maxDelayMs: 2_000,
    breakerThreshold: 5,
    halfOpenAfterMs: 60_000,
  },
  /** AI image generation (BF-038): a minute or more per batch; no retry (a retry would bill twice). */
  'ai-image': {
    timeoutMs: 180_000,
    maxRetries: 0,
    initialDelayMs: 1_000,
    maxDelayMs: 5_000,
    breakerThreshold: 5,
    halfOpenAfterMs: 120_000,
  },
  /** One image downloaded by intel through its SSRF guard (BF-038): intel's deadline is 20 s; one retry. */
  'intel-image': {
    timeoutMs: 30_000,
    maxRetries: 1,
    initialDelayMs: 500,
    maxDelayMs: 2_000,
    breakerThreshold: 10,
    halfOpenAfterMs: 30_000,
  },
  /**
   * Self-hosted Reacher (BF-028): an SMTP conversation can take a while (greylisting, slow servers). No retry here:
   * the verifier chain moves on to the next verifier, and the enrichment engine retries the step.
   */
  reacher: {
    timeoutMs: 60_000,
    maxRetries: 0,
    initialDelayMs: 1_000,
    maxDelayMs: 5_000,
    breakerThreshold: 5,
    halfOpenAfterMs: 120_000,
  },
  /** ZeroBounce (BF-028): its own deadline is the request's `timeout` (20 s); unknown answers are not billed. */
  zerobounce: {
    timeoutMs: 30_000,
    maxRetries: 1,
    initialDelayMs: 1_000,
    maxDelayMs: 5_000,
    breakerThreshold: 5,
    halfOpenAfterMs: 60_000,
  },
  /**
   * Google Place Details for reviews (BF-029): one paid call per business. Not retried (a call that timed out here
   * may have been billed); the step re-checks a failed source within the hour.
   */
  'google-places-reviews': {
    timeoutMs: 15_000,
    maxRetries: 0,
    initialDelayMs: 500,
    maxDelayMs: 3_000,
    breakerThreshold: 5,
    halfOpenAfterMs: 60_000,
  },
  /** The self-hosted scraper's job API (BF-029 review jobs), per request; job creation is never retried. */
  'maps-scraper': {
    // Just above the adapter's own 60 s per request (a result download of up to 5 MB included).
    timeoutMs: 65_000,
    maxRetries: 1,
    initialDelayMs: 1_000,
    maxDelayMs: 5_000,
    breakerThreshold: 5,
    halfOpenAfterMs: 60_000,
  },
  /**
   * PageSpeed Insights (BF-030): a Lighthouse run takes 10–40 s (the adapter allows 90 s); 5xx retried once, quota
   * answers (429) are left to the step (token bucket, re-check later).
   */
  pagespeed: {
    timeoutMs: 95_000,
    maxRetries: 1,
    initialDelayMs: 2_000,
    maxDelayMs: 10_000,
    breakerThreshold: 5,
    halfOpenAfterMs: 120_000,
  },
  /** Scraper job creation (BF-029): never retried (a POST that timed out may have created a job), but breaker-guarded. */
  'maps-scraper-create': {
    timeoutMs: 65_000,
    maxRetries: 0,
    initialDelayMs: 1_000,
    maxDelayMs: 5_000,
    breakerThreshold: 5,
    halfOpenAfterMs: 60_000,
  },
  intel: {
    timeoutMs: 60_000,
    maxRetries: 1,
    initialDelayMs: 500,
    maxDelayMs: 5_000,
    breakerThreshold: 5,
    halfOpenAfterMs: 30_000,
  },
} as const satisfies Record<string, ResiliencePolicyConfig>;

export type ResiliencePolicyName = keyof typeof RESILIENCE_POLICIES;

/** Only transient failures are retried / counted by the breaker: not our own 4xx-class domain errors. */
export const isTransient = (error: unknown): boolean =>
  !(error instanceof DomainError) || (error.httpStatus >= 500 && error.details?.retryable !== false);

/**
 * Runs `fn` under `policy`, giving it the attempt's signal combined with the caller's. A caller's cancellation then
 * rejects inside the call with its own reason (left out of retries and breakers) instead of reaching cockatiel's
 * timeout. Backoff waits between attempts are not interrupted (bounded by the policy's `maxDelayMs`); the next
 * attempt starts already aborted and stops at once.
 */
export function executeWithSignal<T>(
  policy: IPolicy,
  signal: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  // An already-cancelled caller never starts a call: in the breaker's half-open state, cockatiel would count the
  // trial's unhandled cancellation as a success and close it. (A cancellation during the trial still can.)
  if (signal?.aborted) return Promise.reject(signal.reason);
  return policy.execute(({ signal: attempt }) => fn(signal ? AbortSignal.any([signal, attempt]) : attempt));
}

/** Errors a cancelled caller sees (not failures of the dependency). */
export const isCancellation = (error: unknown): boolean =>
  error instanceof Error && CANCELLATIONS.has(error.name);
const CANCELLATIONS = new Set(['AbortError', 'JobCancelledError']);

export function buildPolicy(config: ResiliencePolicyConfig): IPolicy {
  // A cancellation (the caller's signal: fetch's AbortError, or the reason it was aborted with, e.g. a cancelled
  // job) is not an outage: never retried, never counted by the breaker. Callers go through `executeWithSignal` so
  // their signal stays inside the call (passed to `execute`, cockatiel's timeout would turn the abort into a
  // TaskCancelledError, which counts).
  const transient = handleWhen((error) => isTransient(error) && !isCancellation(error));
  return wrap(
    retry(transient, {
      maxAttempts: config.maxRetries,
      backoff: new ExponentialBackoff({ initialDelay: config.initialDelayMs, maxDelay: config.maxDelayMs }),
    }),
    circuitBreaker(transient, {
      halfOpenAfter: config.halfOpenAfterMs,
      breaker: new ConsecutiveBreaker(config.breakerThreshold),
    }),
    timeout(config.timeoutMs, TimeoutStrategy.Aggressive),
  );
}

// Breakers must be shared across calls to work, so policies are built once per name.
const policies = new Map<string, IPolicy>();
export function policyFor(name: ResiliencePolicyName): IPolicy {
  let policy = policies.get(name);
  if (!policy) {
    policy = buildPolicy(RESILIENCE_POLICIES[name]);
    policies.set(name, policy);
  }
  return policy;
}

/**
 * Decorator for adapter methods calling external services: timeout per attempt, retries with jittered
 * exponential backoff, and a circuit breaker shared by every call using the same policy name.
 */
export function WithResilience(name: ResiliencePolicyName = 'default'): MethodDecorator {
  return (_target, _key, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: unknown[]) => Promise<unknown>;
    descriptor.value = function resilient(this: unknown, ...args: unknown[]) {
      return policyFor(name).execute(() => original.apply(this, args));
    };
    return descriptor;
  };
}
