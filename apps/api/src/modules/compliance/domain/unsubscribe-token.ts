import { createHash, createHmac, randomBytes } from 'node:crypto';

// Unsubscribe tokens (BF-055): 128 random bits, base64url in the URL; the database keeps only their SHA-256, so the
// lookup is by hash (no stored working link, no timing difference by token prefix).

export const UNSUBSCRIBE_TTL_DAYS = 730;

export const newUnsubscribeToken = () => randomBytes(16).toString('base64url');

/** A token's lookup key; malformed input yields a hash that matches nothing. */
export const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('base64url');

/** Looks like one of our tokens (22 base64url characters). */
export const isTokenShaped = (token: string) => /^[A-Za-z0-9_-]{22}$/.test(token);

/** The keyed hash kept for lookups and, after erasure, instead of the address. */
export const privacyHash = (pepper: string, scope: string, normalized: string) =>
  createHmac('sha256', pepper).update(`${scope}|${normalized}`).digest('base64url');

/** `j***@example.com`: shown to the person on the page (never the full address to whoever holds the link). */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}
