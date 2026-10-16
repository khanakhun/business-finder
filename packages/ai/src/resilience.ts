import { APICallError } from 'ai';
import {
  BrokenCircuitError,
  ConsecutiveBreaker,
  circuitBreaker,
  ExponentialBackoff,
  handleWhen,
  type IPolicy,
  retry,
  wrap,
} from 'cockatiel';
import type { AiProvider } from './routing.ts';

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/** Transient provider failures: rate limits, overload, 5xx, timeouts, dropped connections. */
export function isRetryableProviderError(error: unknown): boolean {
  if (APICallError.isInstance(error)) {
    return error.isRetryable || (error.statusCode !== undefined && RETRYABLE_STATUS.has(error.statusCode));
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return true;
  return error instanceof TypeError && /fetch|network|socket/i.test(error.message);
}

export const isBrokenCircuit = (error: unknown): boolean => error instanceof BrokenCircuitError;

export interface ResilienceConfig {
  /** Retries after the first attempt. */
  readonly maxRetries: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  /** Consecutive transient failures that open a provider's circuit, and how long it stays open. */
  readonly breakerThreshold: number;
  readonly halfOpenAfterMs: number;
}

export const DEFAULT_RESILIENCE: ResilienceConfig = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 8_000,
  breakerThreshold: 5,
  halfOpenAfterMs: 30_000,
};

/** One retry + circuit-breaker policy per provider, shared by every call of the gateway. */
export class ProviderPolicies {
  private readonly policies = new Map<AiProvider, IPolicy>();
  private readonly config: ResilienceConfig;

  constructor(config: ResilienceConfig = DEFAULT_RESILIENCE) {
    this.config = config;
  }

  for(provider: AiProvider): IPolicy {
    let policy = this.policies.get(provider);
    if (!policy) {
      const transient = handleWhen(isRetryableProviderError);
      policy = wrap(
        retry(transient, {
          maxAttempts: this.config.maxRetries,
          // Decorrelated jitter (cockatiel's default generator) spreads retries from many workers.
          backoff: new ExponentialBackoff({
            initialDelay: this.config.initialDelayMs,
            maxDelay: this.config.maxDelayMs,
          }),
        }),
        circuitBreaker(transient, {
          halfOpenAfter: this.config.halfOpenAfterMs,
          breaker: new ConsecutiveBreaker(this.config.breakerThreshold),
        }),
      );
      this.policies.set(provider, policy);
    }
    return policy;
  }
}
