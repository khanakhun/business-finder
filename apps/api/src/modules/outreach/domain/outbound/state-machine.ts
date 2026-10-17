import { InvalidStateTransitionError, type OutboundStatus } from '@bf/contracts';

// Outbound message lifecycle (DOMAIN §3.5). `queued → queued` is a reschedule (no capacity, a closed window, a new
// time), never an attempt; `sending → queued` hands an unfinished send back after reconciliation found nothing.

const TRANSITIONS: Readonly<Record<OutboundStatus, readonly OutboundStatus[]>> = {
  draft: ['pending_approval', 'queued', 'cancelled'],
  pending_approval: ['queued', 'cancelled'],
  queued: ['queued', 'sending', 'blocked', 'cancelled'],
  sending: ['sent', 'failed', 'blocked', 'queued'],
  failed: ['queued'],
  sent: ['bounced', 'replied'],
  blocked: [],
  cancelled: [],
  bounced: [],
  replied: [],
};

/** Statuses nothing may leave (`failed` may still be retried while attempts remain). */
export const TERMINAL_STATUSES: readonly OutboundStatus[] = ['blocked', 'cancelled', 'bounced', 'replied'];

export function canTransition(from: OutboundStatus, to: OutboundStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OutboundStatus, to: OutboundStatus): void {
  if (!canTransition(from, to)) throw new InvalidStateTransitionError('OutboundMessage', from, to);
}

/** Statuses the undo toast and the outbox may cancel from. */
export const CANCELLABLE: readonly OutboundStatus[] = ['queued', 'pending_approval', 'draft'];
