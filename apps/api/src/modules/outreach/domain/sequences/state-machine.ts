import { type EnrollmentStatus, InvalidStateTransitionError } from '@bf/contracts';

// Sequence enrollment lifecycle (DOMAIN §3.6): active ⇄ paused; either ends stopped (with a reason) or completed.

const TRANSITIONS: Readonly<Record<EnrollmentStatus, readonly EnrollmentStatus[]>> = {
  active: ['paused', 'completed', 'stopped'],
  paused: ['active', 'stopped'],
  completed: [],
  stopped: [],
};

export function assertEnrollmentTransition(from: EnrollmentStatus, to: EnrollmentStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new InvalidStateTransitionError('Enrollment', from, to);
}

export const RUNNING: readonly EnrollmentStatus[] = ['active', 'paused'];
