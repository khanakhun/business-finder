import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logging/logger.ts';
import { ValkeyThrottlerStorage } from './valkey-throttler.storage.ts';

function setup(status: string, evalImpl: () => Promise<unknown>) {
  const valkey = { status, eval: vi.fn(evalImpl) };
  const logger = { warn: vi.fn(), info: vi.fn() };
  const storage = new ValkeyThrottlerStorage(valkey as unknown as Redis, logger as unknown as Logger);
  const hit = () => storage.increment('ip', 60_000, 60, 0, 'default');
  return { valkey, logger, hit };
}

describe('ValkeyThrottlerStorage', () => {
  it('maps the script reply to seconds and the blocked flag', async () => {
    const { hit } = setup('ready', async () => [61, 30_500, 60_000]);
    await expect(hit()).resolves.toEqual({
      totalHits: 61,
      timeToExpire: 31,
      isBlocked: true,
      timeToBlockExpire: 60,
    });
  });

  it('fails open without a round-trip while reconnecting, warning once per outage', async () => {
    const { valkey, logger, hit } = setup('reconnecting', async () => [1, 60_000, -2]);
    for (let i = 0; i < 3; i++)
      await expect(hit()).resolves.toMatchObject({ isBlocked: false, totalHits: 0 });
    expect(valkey.eval).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);

    valkey.status = 'ready';
    await expect(hit()).resolves.toMatchObject({ totalHits: 1 });
    expect(logger.info).toHaveBeenCalledWith('rate limiter available again');
  });

  it('fails open when a command errors (e.g. timeout)', async () => {
    const { logger, hit } = setup('ready', async () => {
      throw new Error('Command timed out');
    });
    await expect(hit()).resolves.toMatchObject({ isBlocked: false });
    await hit();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
