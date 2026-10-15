import {
  InvalidStateTransitionError,
  type RunCounts,
  type RunEndReason,
  type RunStatus,
  TERMINAL_RUN_STATUSES,
} from '@bf/contracts';

// Discovery run lifecycle (DOMAIN.md §3.2): explicit transitions; terminal states are immutable.

const TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['completed', 'partially_completed', 'failed', 'cancelled'],
  completed: [],
  partially_completed: [],
  failed: [],
  cancelled: [],
};

export const isTerminal = (status: RunStatus) => TERMINAL_RUN_STATUSES.includes(status);

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) throw new InvalidStateTransitionError('DiscoveryRun', from, to);
}

/**
 * How a run with no open work ends: every task failed → failed; a budget stop or some failed tasks →
 * partially completed (with the reason); otherwise completed.
 */
export function finalOutcome(
  counts: Pick<RunCounts, 'tasksTotal' | 'tasksDone' | 'tasksFailed' | 'tasksSkipped'>,
  stop: RunEndReason | null,
): { readonly status: RunStatus; readonly reason: RunEndReason | null } {
  // Planned with nothing to do: no registered provider could serve the intent.
  if (counts.tasksTotal === 0 && stop === null) return { status: 'failed', reason: 'no_providers' };
  if (counts.tasksTotal > 0 && counts.tasksFailed === counts.tasksTotal)
    return { status: 'failed', reason: 'tasks_failed' };
  if (stop === 'budget' || stop === 'monthly_budget') return { status: 'partially_completed', reason: stop };
  if (counts.tasksFailed > 0) return { status: 'partially_completed', reason: 'tasks_failed' };
  return { status: 'completed', reason: null };
}
