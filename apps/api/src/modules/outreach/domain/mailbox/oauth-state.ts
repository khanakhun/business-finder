import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// The OAuth `state` parameter (BF-050): a random nonce and an expiry, HMAC-signed. The attempt it points to (org,
// user, PKCE verifier) stays server-side and is usable once, so a leaked or replayed state is worthless.

const b64 = (buffer: Buffer) => buffer.toString('base64url');

export function signState(nonce: string, expiresAtMs: number, key: string): string {
  const body = `${nonce}.${expiresAtMs.toString(36)}`;
  return `${body}.${b64(createHmac('sha256', key).update(body).digest())}`;
}

/** The nonce when the state is authentic and unexpired, else null. */
export function verifyState(state: string, nowMs: number, key: string): string | null {
  const parts = state.split('.');
  if (parts.length !== 3) return null;
  const [nonce, expires, signature] = parts as [string, string, string];
  const expected = createHmac('sha256', key).update(`${nonce}.${expires}`).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (Number.parseInt(expires, 36) < nowMs) return null;
  return nonce;
}

export const newNonce = () => b64(randomBytes(18));

/** PKCE (RFC 7636, S256). */
export function pkcePair(): { readonly verifier: string; readonly challenge: string } {
  const verifier = b64(randomBytes(32));
  return { verifier, challenge: b64(createHash('sha256').update(verifier).digest()) };
}
