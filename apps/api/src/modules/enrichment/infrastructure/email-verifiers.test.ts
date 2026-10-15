import { readFileSync } from 'node:fs';
import { ExternalServiceError } from '@bf/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DnsMxVerifier,
  FakeEmailVerifier,
  ReacherVerifier,
  Semaphore,
  ZeroBounceVerifier,
} from './email-verifiers.ts';

// Adapter tests: recorded-shape (synthetic, fake domains) answers; external HTTP and DNS stubbed at the boundary.
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/email/${name}`, import.meta.url), 'utf8'));

const ORG = 'org-1';
const KEY = '0123456789abcdef0123456789abcdef';
const context = { organizationId: ORG, signal: new AbortController().signal };

const respond = (status: number, body: unknown) => {
  const mock = vi.fn(
    async (_url: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
};

afterEach(() => vi.unstubAllGlobals());

describe('ReacherVerifier', () => {
  it('posts the address to /v1/check_email and maps the answer', async () => {
    const mock = respond(200, fixture('reacher-safe.json'));
    const reacher = new ReacherVerifier('http://reacher.internal:8080', 2);
    expect(await reacher.available()).toBe(true);
    const check = await reacher.verify('contact@salon-ondine.example.com', context);
    expect(check).toMatchObject({ status: 'valid', details: { checkedVia: 'reacher', provider: 'Google' } });
    const [url, init] = mock.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://reacher.internal:8080/v1/check_email');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ to_email: 'contact@salon-ondine.example.com' });
  });

  it('maps a timed-out SMTP conversation to unknown', async () => {
    respond(200, fixture('reacher-timeout.json'));
    const check = await new ReacherVerifier('http://reacher.internal:8080', 2).verify(
      'resa@x.example.com',
      context,
    );
    expect(check.status).toBe('unknown');
  });

  it('is unavailable without a URL', async () => {
    const reacher = new ReacherVerifier(undefined, 2);
    expect(await reacher.available()).toBe(false);
    await expect(reacher.verify('a@b.example.com', context)).rejects.toThrow('not configured');
  });

  it('types failures: 5xx transient, 4xx not, no body text kept', async () => {
    respond(503, { message: 'internal detail' });
    const reacher = new ReacherVerifier('http://reacher.internal:8080', 2);
    const unavailable = await reacher.verify('a@b.example.com', context).catch((e: unknown) => e);
    expect(unavailable).toBeInstanceOf(ExternalServiceError);
    expect((unavailable as ExternalServiceError).details).toMatchObject({
      reason: 'HTTP_503',
      retryable: true,
    });
    expect(String((unavailable as Error).message)).not.toContain('internal detail');
    respond(400, {});
    const bad = await reacher.verify('a@b.example.com', context).catch((e: unknown) => e);
    expect((bad as ExternalServiceError).details).toMatchObject({ reason: 'HTTP_400', retryable: false });
  });
});

describe('ZeroBounceVerifier', () => {
  const key = vi.fn(async (_org: string) => ({ value: KEY, source: 'workspace' as const }));

  it('validates with the workspace key and bills only conclusive answers', async () => {
    const mock = respond(200, fixture('zerobounce-valid.json'));
    const zb = new ZeroBounceVerifier(key, 0.008, 'https://zb.example.test');
    expect(await zb.available(ORG)).toBe(true);
    expect(await zb.verify('contact@salon-ondine.example.com', context)).toMatchObject({
      status: 'valid',
      costUsd: 0.008,
      details: { checkedVia: 'zerobounce', provider: 'g-suite' },
    });
    const url = new URL(String(mock.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe('https://zb.example.test/v2/validate');
    expect(url.searchParams.get('api_key')).toBe(KEY);
    expect(url.searchParams.get('email')).toBe('contact@salon-ondine.example.com');
    expect(url.searchParams.get('timeout')).toBe('20');
    expect(key).toHaveBeenCalledWith(ORG);

    respond(200, fixture('zerobounce-greylisted.json'));
    expect(await zb.verify('resa@hotel-baie.example.com', context)).toMatchObject({
      status: 'unknown',
      costUsd: 0,
    });
  });

  it('an error body (bad key, no credits) is a permanent failure that never quotes the key', async () => {
    respond(200, fixture('zerobounce-error.json'));
    const error = await new ZeroBounceVerifier(key, 0.008, 'https://zb.example.test')
      .verify('a@b.example.com', context)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect((error as ExternalServiceError).details).toMatchObject({
      reason: 'PROVIDER_ERROR',
      retryable: false,
    });
    expect(
      JSON.stringify({ message: (error as Error).message, details: (error as ExternalServiceError).details }),
    ).not.toContain(KEY);
  });

  it('a network error keeps neither the URL nor the key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        throw new TypeError(`fetch failed for ${String(url)}`);
      }),
    );
    const error = await new ZeroBounceVerifier(key, 0.008, 'https://zb.example.test')
      .verify('a@b.example.com', { organizationId: ORG, signal: AbortSignal.timeout(20_000) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect((error as Error).message).not.toContain(KEY);
  }, 10_000);

  it('is unavailable without a key', async () => {
    const zb = new ZeroBounceVerifier(async () => undefined, 0.008);
    expect(await zb.available(ORG)).toBe(false);
  });

  it('tests a key with its credits', async () => {
    respond(200, { Credits: '2500' });
    expect(await ZeroBounceVerifier.testKey(KEY, context.signal, 'https://zb.example.test')).toEqual({
      ok: true,
      message: '2500 credits left.',
    });
    respond(200, { Credits: '-1' });
    expect((await ZeroBounceVerifier.testKey(KEY, context.signal, 'https://zb.example.test')).ok).toBe(false);
  });
});

describe('DnsMxVerifier', () => {
  const noData = () => Object.assign(new Error('queryMx ENODATA'), { code: 'ENODATA' });
  const resolver = (mx: () => Promise<Array<{ exchange: string; priority: number }>>, a: string[] = []) => ({
    resolveMx: vi.fn(mx),
    resolve4: vi.fn(async () => a),
    resolve6: vi.fn(async (): Promise<string[]> => {
      throw noData();
    }),
  });

  it('MX records: unknown mailbox, mail accepted', async () => {
    const dns = new DnsMxVerifier(resolver(async () => [{ exchange: 'aspmx.l.google.com', priority: 1 }]));
    expect(await dns.verify('info@salon.example.com')).toMatchObject({
      status: 'unknown',
      details: { mxAcceptsMail: true, provider: 'Google', checkedVia: 'dns' },
    });
  });

  it('null MX (RFC 7505): invalid', async () => {
    const dns = new DnsMxVerifier(resolver(async () => [{ exchange: '', priority: 0 }]));
    expect((await dns.verify('info@nomail.example.com')).status).toBe('invalid');
  });

  it('no MX: an address record is an implicit MX; none at all is invalid', async () => {
    const withA = resolver(async () => {
      throw noData();
    }, ['192.0.2.10']);
    expect((await new DnsMxVerifier(withA).verify('info@a.example.com')).status).toBe('unknown');
    const none = resolver(async () => {
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    });
    expect((await new DnsMxVerifier(none).verify('info@gone.example.com')).status).toBe('invalid');
  });

  it('a failed lookup is transient', async () => {
    const failing = resolver(async () => {
      throw Object.assign(new Error('SERVFAIL'), { code: 'ESERVFAIL' });
    });
    const error = await new DnsMxVerifier(failing).verify('info@x.example.com').catch((e: unknown) => e);
    expect((error as ExternalServiceError).details).toMatchObject({ reason: 'dns', retryable: true });
  });
});

describe('Semaphore', () => {
  it('runs at most `limit` tasks at once', async () => {
    const slots = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      slots.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
      });
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBe(2);
  });
});

describe('FakeEmailVerifier', () => {
  it.each([
    ['contact@cafe.example.com', 'valid'],
    ['invalid.box@cafe.example.com', 'invalid'],
    ['catchall@cafe.example.com', 'catch_all'],
    ['risky@cafe.example.com', 'risky'],
    ['unknown@cafe.example.com', 'unknown'],
  ])('%s → %s', async (email, status) => {
    expect((await new FakeEmailVerifier().verify(email)).status).toBe(status);
  });
});
