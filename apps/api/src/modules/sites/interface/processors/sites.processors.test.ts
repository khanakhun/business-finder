import type { JobContext } from '@bf/queue';
import { describe, expect, it, vi } from 'vitest';
import type { SiteAssetCommands } from '../../application/site-assets.ts';
import type { SiteCommands } from '../../application/sites.commands.ts';
import { SitesAssetProcessProcessor, SitesExpireProcessor } from './sites.processors.ts';

const context = (attempt: number) =>
  ({
    jobId: 'j',
    attempt,
    signal: new AbortController().signal,
    progress: async () => undefined,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  }) as unknown as JobContext;

describe('SitesAssetProcessProcessor', () => {
  it('lets the queue retry a failure, and marks the image failed on the last attempt', async () => {
    const assets = {
      process: vi.fn(async () => Promise.reject(new Error('decode'))),
      fail: vi.fn(async () => undefined),
    };
    const processor = new SitesAssetProcessProcessor(assets as unknown as SiteAssetCommands);
    const payload = { assetId: '0199e0a0-0000-7000-8000-000000000001' } as never;
    await expect(processor.handle(payload, context(1))).rejects.toThrow('decode');
    expect(assets.fail).not.toHaveBeenCalled();
    await expect(processor.handle(payload, context(3))).resolves.toEqual({ outcome: 'failed' });
    expect(assets.fail).toHaveBeenCalledWith('0199e0a0-0000-7000-8000-000000000001');
  });
});

describe('SitesExpireProcessor', () => {
  it('sweeps stale images every hour, and still expires previews when the sweep fails', async () => {
    const commands = { expireDuePreviews: vi.fn(async () => 0) };
    const assets = { failStale: vi.fn(async () => Promise.reject(new Error('db down'))) };
    const processor = new SitesExpireProcessor(
      commands as unknown as SiteCommands,
      assets as unknown as SiteAssetCommands,
    );
    await expect(processor.handle({} as never, context(1))).resolves.toEqual({ expired: 0 });
    expect(assets.failStale).toHaveBeenCalledOnce();
    expect(commands.expireDuePreviews).toHaveBeenCalled();
  });
});
