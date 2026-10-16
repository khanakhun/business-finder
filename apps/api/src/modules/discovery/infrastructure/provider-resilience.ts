import { DomainError, ExternalServiceError, RateLimitedError } from '@bf/contracts';
import {
  BrokenCircuitError,
  ConsecutiveBreaker,
  circuitBreaker,
  DelegateBackoff,
  handleWhen,
  type IPolicy,
  IsolatedCircuitError,
  retry,
  TimeoutStrategy,
  timeout,
  wrap,
} from 'cockatiel';
import { isCancellation } from '../../platform/resilience/resilience.ts';

// Resilience per discovery provider (BF-018): timeout per attempt, retries on 429/5xx/network errors honouring
// Retry-After, and a breaker per provider so one failing source does not stall every run.

const ATTEMPT_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 30_000;

/** 429, 5xx and network failures are worth retrying; 4xx (bad key, bad request) are not. */
export function isRetryable(error: unknown): boolean {
  // An open breaker answers immediately: retrying it only delays the failure.
  if (error instanceof BrokenCircuitError || error instanceof IsolatedCircuitError) return false;
  if (error instanceof RateLimitedError) return error.details?.retryable !== false;
  if (error instanceof ExternalServiceError) return error.details?.retryable !== false;
  // A cancelled caller (aborted request, cancelled job) is not a provider failure.
  return !(error instanceof DomainError) && !isCancellation(error);
}

/** Retry-After when the provider sent one (bounded), else exponential backoff with full jitter. */
export function retryDelayMs(error: unknown, attempt: number, random = Math.random): number {
  if (error instanceof RateLimitedError && error.retryAfterSeconds !== undefined) {
    return Math.min(MAX_RETRY_AFTER_MS, error.retryAfterSeconds * 1000);
  }
  return Math.round(random() * Math.min(10_000, 500 * 2 ** attempt));
}

export function buildProviderPolicy(
  options: { readonly breakerThreshold?: number; readonly halfOpenAfterMs?: number } = {},
): IPolicy {
  const retryable = handleWhen(isRetryable);
  return wrap(
    retry(retryable, {
      maxAttempts: MAX_ATTEMPTS,
      backoff: new DelegateBackoff((context) =>
        retryDelayMs('error' in context.result ? context.result.error : undefined, context.attempt),
      ),
    }),
    circuitBreaker(retryable, {
      halfOpenAfter: options.halfOpenAfterMs ?? 30_000,
      breaker: new ConsecutiveBreaker(options.breakerThreshold ?? 5),
    }),
    timeout(ATTEMPT_TIMEOUT_MS, TimeoutStrategy.Cooperative),
  );
}
