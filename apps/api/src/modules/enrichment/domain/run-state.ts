import {
  type EnrichmentRunStatus,
  type EnrichmentSkipReason,
  type EnrichmentStepId,
  type EnrichmentStepStatus,
  InvalidStateTransitionError,
  TERMINAL_ENRICHMENT_RUN_STATUSES,
} from '@bf/contracts';

// Enrichment run lifecycle and step readiness (BF-027, ADR-0006): the run's step rows are the DAG; a queued step
// becomes runnable once every dependency is terminal, or is skipped when one will not produce an output.

const TRANSITIONS: Readonly<Record<EnrichmentRunStatus, readonly EnrichmentRunStatus[]>> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['completed', 'partially_completed', 'failed', 'cancelled'],
  completed: [],
  partially_completed: [],
  failed: [],
  cancelled: [],
};

export const isTerminalRun = (status: EnrichmentRunStatus) =>
  TERMINAL_ENRICHMENT_RUN_STATUSES.includes(status);

export function assertRunTransition(from: EnrichmentRunStatus, to: EnrichmentRunStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new InvalidStateTransitionError('EnrichmentRun', from, to);
}

export const isTerminalStep = (status: EnrichmentStepStatus) =>
  status === 'done' || status === 'skipped' || status === 'failed';

export interface StepState {
  readonly id: string;
  readonly step: EnrichmentStepId;
  readonly dependsOn: readonly EnrichmentStepId[];
  readonly status: EnrichmentStepStatus;
  readonly skipReason: EnrichmentSkipReason | null;
}

export type Readiness =
  | { readonly kind: 'ready' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'skip'; readonly reason: EnrichmentSkipReason };

/**
 * Whether a queued step can run: a failed dependency skips it (`dependency_failed`); a dependency skipped for any
 * reason but freshness skips it too (`dependency_skipped`); it waits while a dependency is not terminal. A
 * dependency that is not part of the run (planned away as fresh before this run) does not block, nor does an
 * `optional` one (it only orders the step).
 */
export function readiness(
  step: StepState,
  all: readonly StepState[],
  optional: ReadonlySet<EnrichmentStepId> = new Set(),
): Readiness {
  const byStep = new Map(all.map((s) => [s.step, s]));
  let waiting = false;
  for (const id of step.dependsOn) {
    const dependency = byStep.get(id);
    if (!dependency) continue;
    if (!optional.has(id) && dependency.status === 'failed')
      return { kind: 'skip', reason: 'dependency_failed' };
    if (!optional.has(id) && dependency.status === 'skipped' && dependency.skipReason !== 'fresh') {
      return { kind: 'skip', reason: 'dependency_skipped' };
    }
    if (!isTerminalStep(dependency.status)) waiting = true;
  }
  return waiting ? { kind: 'waiting' } : { kind: 'ready' };
}

/**
 * How a run whose steps are all terminal ends: every step that ran failed → failed; some failed → partially
 * completed; otherwise (done and skipped steps only) → completed.
 */
export function finalStatus(steps: readonly Pick<StepState, 'status'>[]): EnrichmentRunStatus {
  const failed = steps.filter((s) => s.status === 'failed').length;
  const done = steps.filter((s) => s.status === 'done').length;
  if (failed > 0 && done === 0) return 'failed';
  if (failed > 0) return 'partially_completed';
  return 'completed';
}
