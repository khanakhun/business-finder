import { InvalidStateTransitionError, type MailboxStatus } from '@bf/contracts';

// Mailbox lifecycle (DOMAIN §3.7): connected → warming (ramp on) → active; warming/active ⇄ paused; any → error on
// authentication failure or revoked consent; error → connected after reconnection.

const TRANSITIONS: Readonly<Record<MailboxStatus, readonly MailboxStatus[]>> = {
  connected: ['warming', 'active', 'paused', 'error'],
  warming: ['active', 'paused', 'error'],
  active: ['paused', 'error'],
  paused: ['warming', 'active', 'error'],
  error: ['connected'],
};

export function canTransition(from: MailboxStatus, to: MailboxStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: MailboxStatus, to: MailboxStatus): void {
  if (!canTransition(from, to)) throw new InvalidStateTransitionError('Mailbox', from, to);
}

/** Statuses a mailbox may send from. */
export const SENDING_STATUSES: readonly MailboxStatus[] = ['warming', 'active'];

export const canSend = (status: MailboxStatus) => SENDING_STATUSES.includes(status);
