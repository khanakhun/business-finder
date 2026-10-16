import { type GenerationJobStatus, InvalidStateTransitionError } from '@bf/contracts';

// The generation job lifecycle (DOMAIN §3.3), as a typed transition table. A repair attempt runs while the job is
// `repairing` and ends in `validating` again. A person may retry a failed, cancelled or needs-review job (a new
// attempt, `queued` again); succeeded is final.

const TRANSITIONS: Readonly<Record<GenerationJobStatus, readonly GenerationJobStatus[]>> = {
  queued: ['preparing', 'cancelled', 'failed'],
  preparing: ['running', 'failed', 'cancelled'],
  running: ['validating', 'failed', 'cancelled'],
  validating: ['repairing', 'succeeded', 'needs_review', 'failed'],
  repairing: ['validating', 'failed', 'cancelled'],
  failed: ['queued'],
  cancelled: ['queued'],
  needs_review: ['queued'],
  succeeded: [],
};

export function canTransition(from: GenerationJobStatus, to: GenerationJobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: GenerationJobStatus, to: GenerationJobStatus): void {
  if (!canTransition(from, to)) throw new InvalidStateTransitionError('GenerationJob', from, to);
}

/** Work is still to happen on its own (no person needed). */
export const isActive = (status: GenerationJobStatus) =>
  status === 'queued' ||
  status === 'preparing' ||
  status === 'running' ||
  status === 'validating' ||
  status === 'repairing';

/** A person can still cancel it. */
export const isCancellable = (status: GenerationJobStatus) => isActive(status) && status !== 'validating';
