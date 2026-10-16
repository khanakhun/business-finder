import type { ParseSearchIntentResponse } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { ValkeySearchIntentCache } from './valkey-search-intent-cache.ts';

const response: ParseSearchIntentResponse = {
  intent: {
    mode: 'both',
    categories: { ids: [], includeDescendants: true },
    keywords: ['rooftop'],
    location: null,
    filters: {
      website: 'any',
      minRating: null,
      maxRating: null,
      minReviews: null,
      maxReviews: null,
      hasEmail: null,
      hasPhone: null,
      emailVerified: null,
      languages: [],
      priceLevels: [],
      painSignals: [],
      scoreProfile: null,
      minScore: null,
      tiers: [],
      pipelineStatuses: [],
      tags: [],
      addedWithinDays: null,
    },
    sort: { field: 'relevance', direction: 'desc' },
    limit: null,
    needsClarification: null,
    confidence: 0.9,
    warnings: [],
    language: 'en',
  },
  resolvedArea: null,
  alternatives: [],
};

const setup = (valkey: Partial<Record<'get' | 'set', (...args: unknown[]) => Promise<unknown>>>) => {
  const logger = { warn: vi.fn() };
  const cache = new ValkeySearchIntentCache(valkey as unknown as Redis, logger as unknown as Logger);
  return { cache, logger };
};

describe('ValkeySearchIntentCache (best effort)', () => {
  it('round-trips a response under a prefixed key with a TTL', async () => {
    const store = new Map<string, string>();
    const set = vi.fn(async (key: string, value: string) => store.set(key, value));
    const { cache } = setup({ get: async (key) => store.get(key as string) ?? null, set: set as never });
    await cache.set('k', response, 60);
    expect(set).toHaveBeenCalledWith('bf:search:intent:k', expect.any(String), 'EX', 60);
    expect(await cache.get('k')).toEqual(response);
    expect(await cache.get('missing')).toBeUndefined();
  });

  it('treats corrupt, outdated or unreadable entries as misses', async () => {
    const corrupt = setup({ get: async () => '{not json' });
    expect(await corrupt.cache.get('k')).toBeUndefined();
    expect(corrupt.logger.warn).toHaveBeenCalledOnce();
    const outdated = setup({ get: async () => JSON.stringify({ intent: { mode: 'everything' } }) });
    expect(await outdated.cache.get('k')).toBeUndefined();
    expect(outdated.logger.warn).toHaveBeenCalledOnce();
    const down = setup({
      get: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(await down.cache.get('k')).toBeUndefined();
  });

  it('swallows write failures', async () => {
    const { cache, logger } = setup({
      set: async () => {
        throw new Error('READONLY');
      },
    });
    await expect(cache.set('k', response, 60)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
