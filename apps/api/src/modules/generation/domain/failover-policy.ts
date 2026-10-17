import type { EngineId } from '@bf/contracts';

// What happens after an attempt fails (BF-039): a retryable failure retries on the same engine while it has
// attempts left, then moves to the next engine of the failover chain; a fatal one stops the job with its code.

export const FATAL_CODES = new Set([
  'BUDGET_EXCEEDED',
  'POLICY_VIOLATION',
  'INVALID_BRIEF',
  'CANCELLED',
  'ENGINE_UNAVAILABLE',
]);

/** Failures worth another try: time-outs, provider 5xx, a crashed sandbox, an invalid output (once). */
export const RETRYABLE_CODES = new Set([
  'TIMEOUT',
  'PROVIDER_ERROR',
  'SANDBOX_CRASHED',
  // The sandbox's own failures (BF-043): another try, then another engine.
  'SANDBOX_OOM',
  'SANDBOX_TIMEOUT',
  'SANDBOX_CRASH',
  'SANDBOX_PROTOCOL_ERROR',
  'SANDBOX_UNAVAILABLE',
  'HEARTBEAT_LOST',
  'INVALID_OUTPUT',
  'ENGINE_ERROR',
]);

export interface AttemptFailure {
  readonly code: string;
  /** What the engine said; unknown codes follow it. */
  readonly retryable: boolean;
}

export type FailoverDecision =
  | { readonly action: 'retry'; readonly engine: EngineId; readonly reason: string }
  | { readonly action: 'failover'; readonly engine: EngineId; readonly reason: string }
  | { readonly action: 'fail'; readonly code: string; readonly reason: string };

export function decideAfterFailure(
  failure: AttemptFailure,
  job: {
    readonly engine: EngineId;
    /** Attempts made on the current engine (including the failed one). */
    readonly engineAttempts: number;
    readonly maxAttemptsPerEngine: number;
    readonly failoverChain: readonly EngineId[];
    /** Engines that can take the job now (registered, available, allowed for the workspace). */
    readonly available: ReadonlySet<EngineId>;
    /** An invalid output is retried once only. */
    readonly invalidOutputs: number;
  },
): FailoverDecision {
  const fatal = FATAL_CODES.has(failure.code) || (!failure.retryable && !RETRYABLE_CODES.has(failure.code));
  if (fatal) return { action: 'fail', code: failure.code, reason: `${failure.code} is not retryable` };
  const invalidTwice = failure.code === 'INVALID_OUTPUT' && job.invalidOutputs >= 2;
  if (!invalidTwice && job.engineAttempts < job.maxAttemptsPerEngine && job.available.has(job.engine))
    return {
      action: 'retry',
      engine: job.engine,
      reason: `${failure.code}: attempt ${job.engineAttempts + 1} of ${job.maxAttemptsPerEngine} on ${job.engine}`,
    };
  const next = job.failoverChain.find((engine) => engine !== job.engine && job.available.has(engine));
  if (next)
    return {
      action: 'failover',
      engine: next,
      reason: `${failure.code} on ${job.engine}: failing over to ${next}`,
    };
  return { action: 'fail', code: failure.code, reason: `${failure.code}: no attempt or engine left` };
}

/** The failover chain after `engine` (engines already tried are skipped by `decideAfterFailure`). */
export function chainAfter(chain: readonly EngineId[], engine: EngineId): EngineId[] {
  const index = chain.indexOf(engine);
  return index === -1 ? [...chain] : chain.slice(index + 1);
}
