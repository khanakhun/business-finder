import {
  BudgetExceededError,
  ExternalServiceError,
  fixedClock,
  ProviderNotConfiguredError,
  type ProviderQuery,
  RateLimitedError,
} from '@bf/contracts';
import { createLogger } from '@bf/observability';
import { BrokenCircuitError } from 'cockatiel';
import { describe, expect, it, vi } from 'vitest';
import type { SecretResolver } from '../../workspace/index.ts';
import type { ProviderUsageMeter, RateLimiter } from '../application/ports.ts';
import type { DiscoveryProvider } from '../domain/provider.port.ts';
import { GuardedProvider } from './guarded-provider.ts';
import { buildProviderPolicy, isRetryable, retryDelayMs } from './provider-resilience.ts';
import { FakeDiscoveryProvider } from './providers/fake/provider.ts';
import { GooglePlacesProvider } from './providers/google-places/provider.ts';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const clock = fixedClock(NOW);
const query = {
  provider: 'google_places',
  categoryId: null,
  providerKeys: ['cafe'],
  tile: { type: 'Circle', center: { lat: 17.9, lng: -62.85 }, radiusM: 1000 },
  languageCode: 'fr',
  fieldTier: 'pro',
  mode: 'nearby',
  pageNumber: 0,
} satisfies ProviderQuery;
const context = { organizationId: 'org-1', credential: null, signal: new AbortController().signal };

function setup(
  options: {
    secret?: 'workspace' | 'global' | null;
    token?: boolean;
    fetch?: () => Promise<unknown>;
    budget?: number;
    spent?: number;
    meterFails?: boolean;
  } = {},
) {
  const inner = new GooglePlacesProvider(clock);
  const fetchPage = vi.spyOn(inner, 'fetchPage').mockImplementation(
    (options.fetch as never) ??
      (async () => ({
        records: [{} as never, {} as never],
        nextPageToken: null,
        saturated: false,
        sku: 'nearby_search_pro',
      })),
  );
  const secrets = {
    resolve: vi.fn(async () =>
      options.secret === null ? undefined : { value: 'fake-key', source: options.secret ?? 'workspace' },
    ),
  } as unknown as SecretResolver;
  const limiter: RateLimiter = {
    acquire: vi.fn(async () => options.token ?? true),
    tryTake: vi.fn(async () => 0),
  };
  const meter = {
    record: vi.fn(async () => {
      if (options.meterFails) throw new Error('db down');
      return 0.032;
    }),
    monthCostUsd: vi.fn(async () => options.spent ?? 0),
  } as unknown as ProviderUsageMeter;
  const provider = new GuardedProvider(inner, {
    secrets,
    limiter,
    meter,
    clock,
    perSecond: 5,
    policy: () => buildProviderPolicy({ breakerThreshold: 100 }),
    logger: createLogger({ service: 'test', level: 'fatal' }),
    monthlyBudgetUsd: async () => options.budget ?? null,
  });
  return { provider, fetchPage, limiter, meter, secrets };
}

describe('GuardedProvider', () => {
  it('resolves the key, takes a token per key, meters the call and returns its cost', async () => {
    const { provider, fetchPage, limiter, meter } = setup({ secret: 'global' });
    const page = await provider.fetchPage(query, context);
    expect(page.callCostUsd).toBe(0.032);
    expect(fetchPage).toHaveBeenCalledWith(
      query,
      expect.objectContaining({ credential: { value: 'fake-key', source: 'global' } }),
    );
    expect(limiter.acquire).toHaveBeenCalledWith(
      'google_places:global',
      { capacity: 5, perSecond: 5 },
      expect.anything(),
    );
    // On the shared key the workspace also draws from its own fair-share bucket.
    expect(limiter.acquire).toHaveBeenCalledWith(
      'google_places:global:org-1',
      { capacity: 3, perSecond: 2.5 },
      expect.anything(),
    );
    expect(meter.record).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'google_places',
        sku: 'nearby_search_pro',
        billingScope: 'global',
        calls: 1,
        results: 2,
        at: NOW,
      }),
      expect.objectContaining({ perThousandUsd: 32, freeMonthlyCalls: 5_000 }),
    );
  });

  it('bills the workspace scope for a workspace key', async () => {
    const { provider, limiter } = setup({ secret: 'workspace' });
    await provider.fetchPage(query, context);
    expect(limiter.acquire).toHaveBeenCalledTimes(1);
    expect(limiter.acquire).toHaveBeenCalledWith('google_places:org-1', expect.anything(), expect.anything());
  });

  it('stops at the monthly budget before calling', async () => {
    const { provider, fetchPage } = setup({ budget: 10, spent: 10 });
    const error = await provider.fetchPage(query, context).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(fetchPage).not.toHaveBeenCalled();
    await expect(
      setup({ budget: 10, spent: 9.99 }).provider.fetchPage(query, context),
    ).resolves.toBeDefined();
  });

  it('keeps a fetched page when metering fails', async () => {
    const page = await setup({ meterFails: true }).provider.fetchPage(query, context);
    expect(page.records).toHaveLength(2);
    expect(page.callCostUsd).toBe(0);
  });

  it('keeps one breaker per billing account', async () => {
    const failing = setup({
      secret: 'workspace',
      fetch: async () => {
        throw new ExternalServiceError('google-places', 'down', { details: { retryable: false } });
      },
    });
    const policies = (failing.provider as unknown as { policies: Map<string, unknown> }).policies;
    await failing.provider.fetchPage(query, context).catch(() => undefined);
    await failing.provider.fetchPage(query, { ...context, organizationId: 'org-2' }).catch(() => undefined);
    expect([...policies.keys()].sort()).toEqual(['org-1', 'org-2']);
  });

  it('names the missing secret and calls nothing', async () => {
    const { provider, fetchPage } = setup({ secret: null });
    const error = await provider.fetchPage(query, context).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderNotConfiguredError);
    expect((error as Error).message).toContain('"google_places"');
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('refuses when no rate-limit token comes in time', async () => {
    const { provider, fetchPage } = setup({ token: false });
    await expect(provider.fetchPage(query, context)).rejects.toBeInstanceOf(RateLimitedError);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('retries transient failures but not configuration errors', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const flaky = setup({
        fetch: async () => {
          calls++;
          if (calls < 2) throw new RateLimitedError('slow down', 1);
          return { records: [], nextPageToken: null, saturated: false, sku: 'nearby_search_pro' };
        },
      });
      const pending = flaky.provider.fetchPage(query, context);
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;
      expect(calls).toBe(2);

      const denied = setup({
        fetch: async () => {
          throw new ExternalServiceError('google-places', 'denied', { details: { retryable: false } });
        },
      });
      await expect(denied.provider.fetchPage(query, context)).rejects.toBeInstanceOf(ExternalServiceError);
      expect(denied.fetchPage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resilience rules', () => {
  it('retries 429, 5xx and network errors only', () => {
    expect(isRetryable(new RateLimitedError('x'))).toBe(true);
    expect(isRetryable(new ExternalServiceError('s', 'x'))).toBe(true);
    expect(isRetryable(new ExternalServiceError('s', 'x', { details: { retryable: false } }))).toBe(false);
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryable(new ProviderNotConfiguredError('Google', 'google_places'))).toBe(false);
    expect(isRetryable(new BrokenCircuitError())).toBe(false);
  });

  it('honours Retry-After (bounded) and otherwise backs off with jitter', () => {
    expect(retryDelayMs(new RateLimitedError('x', 7), 1)).toBe(7_000);
    expect(retryDelayMs(new RateLimitedError('x', 600), 1)).toBe(30_000);
    expect(retryDelayMs(new Error('x'), 1, () => 1)).toBe(1_000);
    expect(retryDelayMs(new Error('x'), 10, () => 1)).toBe(10_000);
  });
});

describe('FakeDiscoveryProvider', () => {
  const fake: DiscoveryProvider = new FakeDiscoveryProvider(clock);
  const CATEGORY = '00000000-0000-7000-8000-000000000001';

  it('returns fixture businesses inside the tile for the category keys, as import records', async () => {
    const [q] = fake.buildQueries({
      intent: { categoryIds: [CATEGORY], languageCode: 'fr' },
      tile: { type: 'Circle', center: { lat: 17.8968, lng: -62.85 }, radiusM: 800 },
      keysByCategory: new Map([[CATEGORY, [{ key: 'restaurant', label: null }]]]),
      fieldTier: 'pro',
    });
    const page = await fake.fetchPage(q as ProviderQuery, { ...context, credential: null });
    expect(page.records.map((r) => r.name)).toEqual(['Pizzeria Imaginaire']);
    expect(page.records[0]).toMatchObject({
      provider: 'import',
      providerRef: 'fake:bl-012',
      fetchedAt: NOW.toISOString(),
    });
    expect(page).toMatchObject({ saturated: false, nextPageToken: null, sku: 'fixture' });
  });

  it('matches keywords on names when no category is asked', async () => {
    const [q] = fake.buildQueries({
      intent: { categoryIds: [], keywords: 'boulangerie', languageCode: 'fr' },
      tile: { type: 'BBox', bbox: { west: -62.9, south: 17.85, east: -62.78, north: 17.95 } },
      keysByCategory: new Map(),
      fieldTier: 'pro',
    });
    const page = await fake.fetchPage(q as ProviderQuery, { ...context, credential: null });
    expect(page.records.map((r) => r.name)).toEqual(['Boulangerie Démo Lorient']);
  });
});
