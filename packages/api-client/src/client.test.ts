import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client.ts';
import { ApiError } from './errors.ts';
import { defineQueryKeys, shouldRetry } from './query.ts';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const info = {
  name: 'business-finder-api',
  version: '1.2.3',
  commit: null,
  env: 'test',
  time: '2026-10-14T12:00:00.000Z',
};

describe('createApiClient', () => {
  it('returns typed data and sends cookies to the right URL', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(200, info));
    const client = createApiClient({ baseUrl: 'http://api.test', fetch });
    const { data } = await client.GET('/v1/system/info');
    expect(data?.version).toBe('1.2.3');
    const request = fetch.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe('http://api.test/v1/system/info');
    expect(request.credentials).toBe('include');
  });

  it('throws ApiError with the problem for problem+json responses', async () => {
    const problem = {
      type: 'https://errors.business-finder.dev/VALIDATION_FAILED',
      title: 'Validation failed',
      status: 422,
      code: 'VALIDATION_FAILED',
      traceId: 't1',
      errors: [{ path: ['count'], message: 'Too big' }],
    };
    const client = createApiClient({ baseUrl: 'http://api.test', fetch: async () => json(422, problem) });
    const error = await client.POST('/v1/system/ping-jobs', { body: { count: 99 } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).problem).toEqual(problem);
    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).code).toBe('VALIDATION_FAILED');
  });

  it('synthesises a problem for non-JSON failures, keeping the request id as trace reference', async () => {
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: async () =>
        new Response('<html>Bad gateway</html>', { status: 502, headers: { 'x-request-id': 'req-9' } }),
    });
    const error = (await client.GET('/v1/system/info').catch((e: unknown) => e)) as ApiError;
    expect(error.problem).toMatchObject({ status: 502, code: 'INTERNAL', traceId: 'req-9' });
  });

  it('reports network failures as status 0', async () => {
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: async () => Promise.reject(new TypeError('fetch failed')),
    });
    const error = (await client.GET('/v1/system/info').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.problem).toMatchObject({ status: 0, code: 'NETWORK' });
  });
});

describe('query helpers', () => {
  it('builds hierarchical keys', () => {
    const keys = defineQueryKeys('businesses', {
      list: (filters: { q: string }) => ['businesses', 'list', filters] as const,
    });
    expect(keys.all).toEqual(['businesses']);
    expect(keys.list({ q: 'spa' })).toEqual(['businesses', 'list', { q: 'spa' }]);
  });

  it('retries only network and server errors, at most twice', () => {
    const problem = (status: number) => new ApiError({ type: 'x', title: 'x', status, code: 'X' });
    expect(shouldRetry(0, problem(503))).toBe(true);
    expect(shouldRetry(0, problem(0))).toBe(true);
    expect(shouldRetry(2, problem(503))).toBe(false);
    expect(shouldRetry(0, problem(404))).toBe(false);
    expect(shouldRetry(0, new Error('render bug'))).toBe(false);
  });
});
