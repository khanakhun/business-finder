import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cookie = vi.hoisted(() => ({ value: 'session=abc' as string | null }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(cookie.value ? { cookie: cookie.value } : {}),
}));
// React's request cache needs a server render: here every call runs.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  cache: (fn: unknown) => fn,
}));

const { forwardedHeaders, serverGet } = await import('./server-api.ts');

describe('serverGet', () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  beforeEach(() => {
    cookie.value = 'session=abc';
    vi.stubGlobal('fetch', fetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetch.mockReset();
  });

  it('forwards the browser cookie and returns the JSON body', async () => {
    fetch.mockResolvedValue(new Response(JSON.stringify({ id: 'b1' }), { status: 200 }));
    expect(await serverGet<{ id: string }>('/v1/businesses/b1')).toEqual({ ok: true, data: { id: 'b1' } });
    const [url, init] = fetch.mock.calls[0] ?? ['', {}];
    expect(String(url)).toMatch(/\/v1\/businesses\/b1$/);
    expect(new Headers(init?.headers).get('cookie')).toBe('session=abc');
  });

  it('reports HTTP and network failures without throwing', async () => {
    fetch.mockResolvedValueOnce(new Response('{}', { status: 404 }));
    expect(await serverGet('/v1/x')).toEqual({ ok: false, status: 404 });
    fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await serverGet('/v1/x')).toEqual({ ok: false, status: 0 });
  });

  it('does not call the API without a session cookie', async () => {
    cookie.value = null;
    expect(await serverGet('/v1/x')).toEqual({ ok: false, status: 401 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards the visitor's address only when a proxy reported it", () => {
    expect(forwardedHeaders(new Headers({ cookie: 'a=b', 'x-forwarded-for': '203.0.113.7' }))).toEqual({
      cookie: 'a=b',
      'x-forwarded-for': '203.0.113.7',
    });
    expect(forwardedHeaders(new Headers({ cookie: 'a=b' }))).toEqual({ cookie: 'a=b' });
  });
});
