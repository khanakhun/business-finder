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
  /** External geocoders (BF-017): short, few retries — users wait for location resolution. */
  geocoder: {
    timeoutMs: 8_000,
    maxRetries: 1,
    initialDelayMs: 500,
    maxDelayMs: 2_000,
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
  !(error instanceof DomainError) || error.httpStatus >= 500;

export function buildPolicy(config: ResiliencePolicyConfig): IPolicy {
  const transient = handleWhen(isTransient);
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
