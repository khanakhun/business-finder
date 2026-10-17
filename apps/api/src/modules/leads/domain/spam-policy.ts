import type { LeadKind, SpamVerdict } from '@bf/contracts';

// How a lead's spam signals become a verdict (BF-048, Specification): each signal weighs; at or above the threshold a
// claim or contact request is stored as spam and starts no automation. An opt-out is never refused for spam — wrongly
// ignoring "don't contact me" is worse than honouring a fake one — so its signals are recorded only.

export type SpamSignal =
  | 'honeypot'
  | 'too_fast'
  | 'too_old'
  | 'bad_form_token'
  | 'altcha_missing'
  | 'altcha_failed'
  | 'rate_ip'
  | 'rate_site'
  | 'links'
  | 'markup'
  | 'disposable_email'
  | 'repeated'
  | 'no_channel';

export const SPAM_WEIGHTS: Readonly<Record<SpamSignal, number>> = {
  honeypot: 100,
  too_fast: 60,
  too_old: 40,
  bad_form_token: 60,
  altcha_missing: 25,
  altcha_failed: 70,
  rate_ip: 60,
  rate_site: 40,
  links: 30,
  markup: 50,
  disposable_email: 30,
  repeated: 50,
  no_channel: 20,
};

export const SPAM_THRESHOLD = 60;
/** The form must have been on screen this long… */
export const MIN_FILL_MS = 3_000;
/** …and not longer than this (a replayed form). */
export const MAX_FORM_AGE_MS = 24 * 60 * 60_000;

export function verdict(signals: readonly SpamSignal[]): SpamVerdict {
  const unique = [...new Set(signals)];
  const score = Math.min(
    100,
    unique.reduce((sum, signal) => sum + SPAM_WEIGHTS[signal], 0),
  );
  return { score, signals: unique };
}

export function isSpam(kind: LeadKind, result: SpamVerdict): boolean {
  return kind !== 'opt_out' && result.score >= SPAM_THRESHOLD;
}

const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;
const MARKUP = /<\s*\/?\s*(script|iframe|a|img|style|object|embed|svg)\b|javascript:|on\w+\s*=/i;
/** A short list of throwaway mailbox domains (the common ones; not exhaustive by design). */
const DISPOSABLE = new Set([
  'mailinator.com',
  'guerrillamail.com',
  '10minutemail.com',
  'tempmail.com',
  'temp-mail.org',
  'yopmail.com',
  'trashmail.com',
  'getnada.com',
  'sharklasers.com',
  'dispostable.com',
]);

/** Signals from what was written (links, markup, a throwaway address, no way to call back on a claim). */
export function contentSignals(lead: {
  readonly kind: LeadKind;
  readonly message?: string | undefined;
  readonly name?: string | undefined;
  readonly email?: string | undefined;
  readonly phone?: string | undefined;
  readonly whatsapp?: string | undefined;
}): SpamSignal[] {
  const signals: SpamSignal[] = [];
  const text = `${lead.name ?? ''} ${lead.message ?? ''}`;
  if ((text.match(URL_PATTERN) ?? []).length > 1) signals.push('links');
  if (MARKUP.test(text)) signals.push('markup');
  const domain = lead.email?.split('@')[1]?.toLowerCase();
  if (domain && DISPOSABLE.has(domain)) signals.push('disposable_email');
  if (lead.kind === 'claim_interest' && !lead.email && !lead.phone && !lead.whatsapp)
    signals.push('no_channel');
  return signals;
}

/** Signals from the form's timing (rendered too recently, or too long ago). */
export function timingSignals(renderedAtMs: number | undefined, nowMs: number): SpamSignal[] {
  if (renderedAtMs === undefined) return ['bad_form_token'];
  const age = nowMs - renderedAtMs;
  if (age < MIN_FILL_MS) return ['too_fast'];
  if (age > MAX_FORM_AGE_MS) return ['too_old'];
  return [];
}
