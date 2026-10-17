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

/**
 * Fatal for this engine only (BF-044): no retry on it, straight to the next engine of the chain (a cheaper one when
 * its budget ran out, another one when its CLI version is not supported).
 */
export const ENGINE_FATAL_CODES = new Set(['ENGINE_BUDGET_EXCEEDED', 'ENGINE_VERSION_UNSUPPORTED']);

/** An invalid result: retried once on the engine, then another engine. */
export const INVALID_OUTPUT_CODES = new Set(['INVALID_OUTPUT', 'ENGINE_INVALID_OUTPUT']);

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
  // A coding agent that stopped before `sitekit check` passed, or whose result failed validation (BF-044).
  'ENGINE_INCOMPLETE',
  'ENGINE_INVALID_OUTPUT',
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
  const engineFatal = ENGINE_FATAL_CODES.has(failure.code);
  const fatal =
    FATAL_CODES.has(failure.code) ||
    (!engineFatal && !failure.retryable && !RETRYABLE_CODES.has(failure.code));
  if (fatal) return { action: 'fail', code: failure.code, reason: `${failure.code} is not retryable` };
  const invalidTwice = INVALID_OUTPUT_CODES.has(failure.code) && job.invalidOutputs >= 2;
  if (
    !engineFatal &&
    !invalidTwice &&
    job.engineAttempts < job.maxAttemptsPerEngine &&
    job.available.has(job.engine)
  )
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
