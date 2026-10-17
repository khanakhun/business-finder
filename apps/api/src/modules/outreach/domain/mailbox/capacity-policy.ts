import type { MailboxRamp, MailboxStatus } from '@bf/contracts';
import { canSend } from './mailbox-state-machine.ts';

// Daily capacity (BF-050): a gradual ramp of real sending — `min(maxCap, startCap + increment ×
// floor(daysSinceStart / everyDays))` — bounded by the mailbox's daily cap; nothing when it cannot send.

const DAY_MS = 86_400_000;

export interface CapacityInput {
  readonly status: MailboxStatus;
  readonly dailyCap: number;
  readonly ramp: MailboxRamp;
}

/** The ramp's cap on `at` (no status check), or the daily cap when the ramp is off or not started. */
export function rampCap(input: Pick<CapacityInput, 'dailyCap' | 'ramp'>, at: Date): number {
  const { ramp, dailyCap } = input;
  if (!ramp.enabled || !ramp.startedAt) return dailyCap;
  const days = Math.max(0, Math.floor((at.getTime() - Date.parse(ramp.startedAt)) / DAY_MS));
  const ramped = Math.min(ramp.maxCap, ramp.startCap + ramp.increment * Math.floor(days / ramp.everyDays));
  return Math.max(0, Math.min(dailyCap, ramped));
}

export function effectiveCap(input: CapacityInput, at: Date): number {
  return canSend(input.status) ? rampCap(input, at) : 0;
}

/** Whether the ramp has reached its ceiling (warming → active). */
export function rampComplete(input: Pick<CapacityInput, 'dailyCap' | 'ramp'>, at: Date): boolean {
  if (!input.ramp.enabled || !input.ramp.startedAt) return true;
  return rampCap(input, at) >= Math.min(input.ramp.maxCap, input.dailyCap);
}

/** The planned cap for each of the next `days` days from `from` (the ramp chart). */
export function rampPlan(
  input: Pick<CapacityInput, 'dailyCap' | 'ramp'>,
  from: Date,
  days: number,
): { readonly at: Date; readonly cap: number }[] {
  return Array.from({ length: days }, (_, index) => {
    const at = new Date(from.getTime() + index * DAY_MS);
    return { at, cap: rampCap(input, at) };
  });
}
