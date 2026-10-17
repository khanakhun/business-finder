import type { Locale, MailboxStatus } from '@bf/contracts';
import { canSend } from './mailbox-state-machine.ts';

// Rotation (BF-050, Strategy): a follow-up stays with its thread's mailbox; otherwise mailboxes that can send, speak
// the recipient's language and have capacity left are ranked by remaining capacity ratio, recent bounce rate and
// round-robin fairness (least recently selected first).

export interface MailboxCandidate {
  readonly id: string;
  readonly status: MailboxStatus;
  readonly locales: readonly Locale[];
  readonly effectiveCap: number;
  readonly used: number;
  /** Bounces / sent over the last 7 days (0 when nothing was sent). */
  readonly bounceRate: number;
  readonly lastSelectedAt: Date | null;
}

const WEIGHTS = { capacity: 0.6, bounces: 0.3, fairness: 0.1 } as const;
const FAIRNESS_HORIZON_MS = 24 * 3_600_000;

export const remaining = (candidate: MailboxCandidate) =>
  Math.max(0, candidate.effectiveCap - candidate.used);

export function eligible(candidate: MailboxCandidate, locale: Locale | null): boolean {
  if (!canSend(candidate.status) || remaining(candidate) === 0) return false;
  return locale === null || candidate.locales.length === 0 || candidate.locales.includes(locale);
}

export function score(candidate: MailboxCandidate, now: Date): number {
  const capacity = candidate.effectiveCap > 0 ? remaining(candidate) / candidate.effectiveCap : 0;
  const idle = candidate.lastSelectedAt
    ? now.getTime() - candidate.lastSelectedAt.getTime()
    : FAIRNESS_HORIZON_MS;
  const fairness = Math.min(1, Math.max(0, idle) / FAIRNESS_HORIZON_MS);
  return (
    WEIGHTS.capacity * capacity +
    WEIGHTS.bounces * (1 - Math.min(1, candidate.bounceRate)) +
    WEIGHTS.fairness * fairness
  );
}

/** Eligible candidates, best first (ties broken by id for determinism). */
export function rank(
  candidates: readonly MailboxCandidate[],
  locale: Locale | null,
  now: Date,
): MailboxCandidate[] {
  return candidates
    .filter((candidate) => eligible(candidate, locale))
    .map((candidate) => ({ candidate, score: score(candidate, now) }))
    .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id))
    .map(({ candidate }) => candidate);
}
