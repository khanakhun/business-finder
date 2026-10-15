import { ExternalServiceError } from '@bf/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AppEnv } from '../config/app-env.ts';
import { IntelClient } from './intel-client.ts';

const env = { INTEL_URL: 'http://intel.test:8000', INTEL_SHARED_SECRET: 's'.repeat(40) } as unknown as AppEnv;
const Schema = z.object({ ok: z.boolean() });

afterEach(() => vi.unstubAllGlobals());

describe('IntelClient', () => {
  it('signs the request over method, path and body and validates the answer', async () => {
    const fetchMock = vi.fn(async (_url: URL, _init?: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new IntelClient(env).post('/v1/echo', { message: 'hi' }, Schema);
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://intel.test:8000/v1/echo');
    expect(new Headers(init?.headers).get('authorization')).toMatch(
      /^Bearer \d+\.[A-Za-z0-9_-]{16,64}\.[0-9a-f]{64}$/,
    );
    expect(init?.body).toBe('{"message":"hi"}');
  });

  it('does not retry 4xx answers and retries 5xx once', async () => {
    const bad = vi.fn(async () => Response.json({ code: 'VALIDATION_FAILED' }, { status: 422 }));
    vi.stubGlobal('fetch', bad);
    const error = await new IntelClient(env).post('/v1/x', {}, Schema).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect((error as ExternalServiceError).details).toMatchObject({
      reason: 'VALIDATION_FAILED',
      retryable: false,
    });
    expect(bad).toHaveBeenCalledTimes(1);

    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ++calls === 1 ? new Response('down', { status: 503 }) : Response.json({ ok: true }),
      ),
    );
    expect(await new IntelClient(env).post('/v1/y', {}, Schema)).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('rejects bodies that do not match the contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: 'yes' })),
    );
    await expect(new IntelClient(env).post('/v1/z', {}, Schema)).rejects.toBeInstanceOf(ExternalServiceError);
  });
});
