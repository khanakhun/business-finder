// base64url and HMAC on Web APIs only (TextEncoder, btoa/atob, crypto.subtle): no Node `Buffer`/`crypto`.

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Returns undefined for anything that is not canonical base64url. */
export function fromBase64Url(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined;
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
}

/** The SHA-256 of a text (UTF-8), as lowercase hex. */
export async function sha256Hex(data: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Length-independent comparison so signature checks don't leak timing. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** JSON with sorted keys at every depth (undefined members dropped): equal values give equal strings. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => (item === undefined ? 'null' : stableJson(item))).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
