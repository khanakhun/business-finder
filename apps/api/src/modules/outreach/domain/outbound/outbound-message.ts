import type { ComplianceDecision } from '@bf/contracts';
import { ComplianceRefusedError } from './errors.ts';

// The gate's evidence as a type (BF-052): a message enters `queued` only with an `AllowedDecisionId`, and the only
// way to get one is `allowedDecision()`, which checks the persisted decision at runtime. The database enforces the
// same rule with a check constraint.

declare const allowed: unique symbol;
export type AllowedDecisionId = string & { readonly [allowed]: true };

export const MAX_SEND_ATTEMPTS = 3;

/** The id of a persisted allowing decision, or a typed refusal (manual-only → 409, blocked → 422). */
export function allowedDecision(decision: ComplianceDecision): AllowedDecisionId {
  if (decision.decision === 'allowed' || decision.decision === 'allowed_with_conditions') {
    if (!decision.id) throw new Error('A preview decision cannot queue a message');
    return decision.id as AllowedDecisionId;
  }
  throw new ComplianceRefusedError(decision);
}

/** When the message goes: after the undo window, or later when scheduled. */
export function scheduledAt(now: Date, undoWindowSeconds: number, requested: Date | null): Date {
  const earliest = now.getTime() + undoWindowSeconds * 1000;
  return new Date(Math.max(earliest, requested?.getTime() ?? 0));
}

/** RFC 5322 Message-ID: `<id@domain>` with the mailbox's domain. */
export function rfc822MessageId(messageId: string, fromAddress: string): string {
  const domain = fromAddress.split('@')[1]?.toLowerCase() || 'localhost';
  return `<${messageId}@${domain}>`;
}

/** `j…@example.com` (lists show who, not the full address). */
export function maskAddress(email: string | null): string {
  if (!email) return '—';
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}…@${domain}`;
}
