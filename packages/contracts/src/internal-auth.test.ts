import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { canonicalString, INTERNAL_AUTH_NONCE_PATTERN, signInternalRequest } from './internal-auth.ts';

interface Vector {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly body?: string;
  readonly timestamp: number;
  readonly nonce: string;
  readonly canonical: string;
  readonly authorization: string;
}
// Shared with services/intel/tests/test_internal_auth.py: both languages must produce these exact values.
const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/internal-auth-vectors.json', import.meta.url), 'utf8'),
) as { secret: string; vectors: Vector[] };

describe('signInternalRequest', () => {
  it.each(fixture.vectors)('matches the shared vector: $name', async (v) => {
    const request = { method: v.method, path: v.path, ...(v.body === undefined ? {} : { body: v.body }) };
    expect(await canonicalString(request, v.timestamp, v.nonce)).toBe(v.canonical);
    expect(
      await signInternalRequest(request, { secret: fixture.secret, timestamp: v.timestamp, nonce: v.nonce }),
    ).toBe(v.authorization);
  });

  it('signs bytes and the same text identically', async () => {
    const options = { secret: fixture.secret, timestamp: 1, nonce: 'AAAAAAAAAAAAAAAAAAAAAA' };
    const text = await signInternalRequest({ method: 'POST', path: '/x', body: 'é' }, options);
    const bytes = await signInternalRequest(
      { method: 'POST', path: '/x', body: new TextEncoder().encode('é') },
      options,
    );
    expect(bytes).toBe(text);
  });

  it('defaults to the current time and a fresh random nonce', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-15T00:00:00Z') });
    try {
      const a = await signInternalRequest({ method: 'GET', path: '/v1/echo' }, { secret: fixture.secret });
      const b = await signInternalRequest({ method: 'GET', path: '/v1/echo' }, { secret: fixture.secret });
      const [ts, nonce, signature] = a.replace(/^Bearer /, '').split('.');
      expect(Number(ts)).toBe(Date.parse('2026-10-15T00:00:00Z') / 1000);
      expect(nonce).toMatch(INTERNAL_AUTH_NONCE_PATTERN);
      expect(signature).toMatch(/^[0-9a-f]{64}$/);
      expect(b).not.toBe(a);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects nonces with separators and non-integer timestamps', async () => {
    const request = { method: 'GET', path: '/' };
    await expect(
      signInternalRequest(request, { secret: 's', nonce: 'has.a.dot.in-it-xxxx' }),
    ).rejects.toThrow(/nonce/);
    await expect(signInternalRequest(request, { secret: 's', nonce: 'short' })).rejects.toThrow(/nonce/);
    await expect(signInternalRequest(request, { secret: 's', timestamp: 1.5 })).rejects.toThrow(/timestamp/);
  });
});
