import { createHmac } from 'node:crypto';
import { canonicalString } from '@bf/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../platform/config/app-env.ts';
import type { Logger } from '../../platform/logging/logger.ts';
import { REVALIDATE_PATH, RendererRevalidator } from './renderer-revalidator.ts';

const SECRET = 'revalidate-secret-revalidate-secret-0';
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const env = (overrides: Record<string, unknown> = {}) =>
  ({ NODE_ENV: 'test', SITES_INTERNAL_URL: 'http://sites.internal:3100', ...overrides }) as unknown as AppEnv;

afterEach(() => vi.unstubAllGlobals());

describe('RendererRevalidator', () => {
  it('sends nothing without a secret, and refuses to start without one in production', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await new RendererRevalidator(env(), logger).revalidate({ tags: ['site:abc'] })).toBe('skipped');
    expect(fetch).not.toHaveBeenCalled();
    expect(() => new RendererRevalidator(env({ NODE_ENV: 'production' }), logger)).toThrow(
      /SITES_REVALIDATE_SECRET/,
    );
  });

  it('posts the tags signed over method, path and body', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    const revalidator = new RendererRevalidator(env({ SITES_REVALIDATE_SECRET: SECRET }), logger);
    expect(await revalidator.revalidate({ tags: ['site:abc', 'host:salon.sites.test'] })).toBe('sent');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://sites.internal:3100${REVALIDATE_PATH}`);
    expect(init.body).toBe('{"tags":["site:abc","host:salon.sites.test"]}');
    const [, token = ''] = String((init.headers as Record<string, string>).Authorization).split(' ');
    const [timestamp, nonce, signature] = token.split('.');
    const canonical = await canonicalString(
      { method: 'POST', path: REVALIDATE_PATH, body: init.body as string },
      Number(timestamp),
      nonce ?? '',
    );
    expect(signature).toBe(createHmac('sha256', SECRET).update(canonical).digest('hex'));
  });

  it('fails (for the job to retry) when the renderer answers an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    const revalidator = new RendererRevalidator(env({ SITES_REVALIDATE_SECRET: SECRET }), logger);
    await expect(revalidator.revalidate({ tags: ['site:abc'] })).rejects.toThrow(/503/);
  });
});
