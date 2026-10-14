// Service-to-service authentication for services/intel (ADR-0002, BF-008). The Python verifier lives in
// services/intel/app/security/internal_auth.py; both sides are pinned to fixtures/internal-auth-vectors.json.
import { hmacSha256, toBase64Url } from './encoding.ts';

/** Accepted distance between the signer's and the verifier's clocks, in seconds. */
export const INTERNAL_AUTH_MAX_SKEW_SECONDS = 60;

/** Nonces are base64url, so they never contain the `.` and `|` separators. */
export const INTERNAL_AUTH_NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export interface InternalRequest {
  /** HTTP method; signed upper-cased. */
  readonly method: string;
  /** Path and query exactly as sent on the wire (`URL.pathname + URL.search`), e.g. `/v1/echo?x=1`. */
  readonly path: string;
  /** Request body bytes (strings are UTF-8 encoded). Omit for no body. */
  readonly body?: string | Uint8Array;
}

export interface SignInternalRequestOptions {
  readonly secret: string;
  /** Unix time in seconds; defaults to now. */
  readonly timestamp?: number;
  /** Defaults to 16 random bytes, base64url. Fixed only in test vectors. */
  readonly nonce?: string;
}

/**
 * Returns the `Authorization` header value for a call to services/intel:
 * `Bearer <unix_ts>.<nonce>.<hex(hmac_sha256(secret, ts|nonce|METHOD|path|hex(sha256(body))))>`.
 */
export async function signInternalRequest(
  request: InternalRequest,
  options: SignInternalRequestOptions,
): Promise<string> {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('timestamp must be unix seconds');
  const nonce = options.nonce ?? toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  if (!INTERNAL_AUTH_NONCE_PATTERN.test(nonce)) throw new Error('nonce must be 16-64 base64url characters');
  const signature = await hmacSha256(options.secret, await canonicalString(request, timestamp, nonce));
  return `Bearer ${timestamp}.${nonce}.${toHex(signature)}`;
}

/** The exact string that is signed (exported for test vectors and debugging). */
export async function canonicalString(
  request: InternalRequest,
  timestamp: number,
  nonce: string,
): Promise<string> {
  // A copy is always ArrayBuffer-backed, which `digest` requires (a view could sit on a SharedArrayBuffer).
  const body =
    typeof request.body === 'string'
      ? new TextEncoder().encode(request.body)
      : new Uint8Array(request.body ?? []);
  const bodyHash = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', body)));
  return [String(timestamp), nonce, request.method.toUpperCase(), request.path, bodyHash].join('|');
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
