import { type DsrStatus, InvalidStateTransitionError } from '@bf/contracts';

// Data-subject request lifecycle (BF-055): received → verifying → in_progress → completed; rejected from any open
// state. Completed and rejected are final.

const TRANSITIONS: Readonly<Record<DsrStatus, readonly DsrStatus[]>> = {
  received: ['verifying', 'in_progress', 'rejected'],
  verifying: ['in_progress', 'rejected'],
  in_progress: ['completed', 'rejected'],
  completed: [],
  rejected: [],
};

export function assertDsrTransition(from: DsrStatus, to: DsrStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new InvalidStateTransitionError('DsrRequest', from, to);
}

export const isOpen = (status: DsrStatus) => status !== 'completed' && status !== 'rejected';

/** Reminder thresholds before the deadline (days). */
export const REMINDER_DAYS = [7, 2] as const;

/** The reminders due now that were not sent yet. */
export function dueReminders(
  dueAt: Date,
  now: Date,
  sent: readonly string[],
): (typeof REMINDER_DAYS)[number][] {
  const days = (dueAt.getTime() - now.getTime()) / 86_400_000;
  return REMINDER_DAYS.filter((threshold) => days <= threshold && !sent.includes(String(threshold)));
}
