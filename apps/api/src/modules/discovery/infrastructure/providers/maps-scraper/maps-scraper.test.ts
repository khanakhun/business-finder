import { readFileSync } from 'node:fs';
import { ExternalServiceError, ForbiddenError, fixedClock, type ProviderQuery } from '@bf/contracts';
import { createLogger } from '@bf/observability';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeatureFlagService, SecretResolver, WorkspaceDefaults } from '../../../../workspace/index.ts';
import { ProviderSelectionService } from '../../../application/discovery.services.ts';
import type { ProviderUsageMeter } from '../../../application/ports.ts';
import { ProviderRegistry } from '../../../application/provider-registry.ts';
import { GuardedProvider } from '../../guarded-provider.ts';
import { buildProviderPolicy } from '../../provider-resilience.ts';
import { csvObjects, parseCsv } from './csv.ts';
import { scraperRecord } from './mapper.ts';
import { MapsScraperProvider } from './provider.ts';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const csv = readFileSync(new URL('./__fixtures__/job.csv', import.meta.url), 'utf8');
const box = { type: 'BBox' as const, bbox: { west: -62.88, south: 17.87, east: -62.79, north: 17.93 } };
const CAFE = '00000000-0000-7000-8000-000000000001';
const context = { organizationId: 'org-1', credential: null, signal: new AbortController().signal };

afterEach(() => vi.unstubAllGlobals());

const scraper = (acknowledged = true) =>
  new MapsScraperProvider({
    clock: fixedClock(NOW),
    baseUrl: 'http://scraper.test:8080',
    maxTimeSeconds: 300,
    acknowledged: async () => acknowledged,
  });

describe('scraper CSV', () => {
  it('parses quoted fields, escaped quotes and JSON columns', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
    const rows = csvObjects(csv);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.title).toBe('Restaurant Fictif "La Vague"');
  });

  it('maps rows to short-lived records without reviews', () => {
    const records = csvObjects(csv).flatMap((row) => scraperRecord(row, NOW) ?? []);
    expect(records).toMatchSnapshot();
    expect(records[0]).toMatchObject({
      provider: 'gmaps_scraper',
      providerRef: 'ChIJScraperFixture00001',
      expiresAt: '2026-11-14T12:00:00.000Z',
      emails: ['contact@la-vague.example'],
      address: { city: 'Gustavia', countryCode: 'BL' },
    });
    expect(JSON.stringify(records)).not.toContain('never stored');
    expect(records[1]?.operatingStatus).toBe('closed_permanently');
  });
});

describe('MapsScraperProvider jobs', () => {
  const provider = scraper();
  const [query] = provider.buildQueries({
    intent: { categoryIds: [CAFE], languageCode: 'fr' },
    tile: box,
    keysByCategory: new Map([
      [
        CAFE,
        [
          { key: 'restaurant', label: 'restaurant' },
          { key: 'cafe', label: null },
        ],
      ],
    ]),
    fieldTier: 'pro',
  });

  it('creates a job, polls it, downloads its CSV and deletes it', async () => {
    const calls: Array<[string, string]> = [];
    let state = 'working';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init?: RequestInit) => {
        calls.push([init?.method ?? 'GET', url.pathname]);
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body));
          expect(body).toMatchObject({
            keywords: ['restaurant', 'cafe'],
            lang: 'fr',
            depth: 1,
            max_time: 300,
            zoom: 15,
          });
          expect(typeof body.lat).toBe('string');
          return Response.json({ id: 'job-123' }, { status: 201 });
        }
        if (url.pathname.endsWith('/download'))
          return new Response(csv, { headers: { 'content-type': 'text/csv' } });
        if (init?.method === 'DELETE') return new Response(null, { status: 200 });
        return Response.json({ ID: 'job-123', Status: state });
      }),
    );
    const created = await provider.fetchPage(query as ProviderQuery, context);
    expect(created).toMatchObject({ records: [], nextPageToken: 'job:job-123', pollAfterMs: 60_000 });
    const pending = await provider.fetchPage(
      { ...(query as ProviderQuery), pageToken: 'job:job-123' },
      context,
    );
    expect(pending).toMatchObject({ records: [], nextPageToken: 'job:job-123', pollAfterMs: 30_000 });
    state = 'ok';
    const done = await provider.fetchPage({ ...(query as ProviderQuery), pageToken: 'job:job-123' }, context);
    expect(done.nextPageToken).toBeNull();
    expect(done.records.map((r) => r.providerRef)).toEqual([
      'ChIJScraperFixture00001',
      'ChIJScraperFixture00002',
    ]);
    expect(calls).toContainEqual(['DELETE', '/api/v1/jobs/job-123']);
  });

  it('fails a failed job (deleting it) and rejects forged tokens', async () => {
    const methods: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, init?: RequestInit) => {
        methods.push(init?.method ?? 'GET');
        return init?.method === 'DELETE' ? new Response(null) : Response.json({ Status: 'failed' });
      }),
    );
    await expect(
      provider.fetchPage({ ...(query as ProviderQuery), pageToken: 'job:x' }, context),
    ).rejects.toBeInstanceOf(ExternalServiceError);
    expect(methods).toContain('DELETE');
    await expect(
      provider.fetchPage({ ...(query as ProviderQuery), pageToken: '../../etc' }, context),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });
});

describe('scraper job budget', () => {
  it('polls for as long as the job may run', () => {
    expect(scraper().maxPages()).toBe(2 + Math.ceil(600 / 30));
  });

  it('refuses unexpected job answers with a typed error', async () => {
    const provider = scraper();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ nope: true }, { status: 201 })),
    );
    const [query] = provider.buildQueries({
      intent: { categoryIds: [], keywords: 'restaurant', languageCode: 'fr' },
      tile: box,
      keysByCategory: new Map(),
      fieldTier: 'pro',
    });
    await expect(provider.fetchPage(query as ProviderQuery, context)).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
  });
});

describe('scraper gates (truth table)', () => {
  const settings = {
    discoverySettings: vi.fn(async () => ({
      providerOrder: [],
      disabledProviders: [],
      googleFieldTier: 'pro',
      overtureRelease: null,
      monthlyBudgetUsd: null,
    })),
  } as unknown as WorkspaceDefaults;
  const secrets = { resolve: vi.fn(async () => undefined) } as unknown as SecretResolver;
  const meter = {
    monthCostUsd: vi.fn(async () => 0),
    record: vi.fn(async () => 0),
  } as unknown as ProviderUsageMeter;

  const guarded = (acknowledged: boolean) =>
    new GuardedProvider(scraper(acknowledged), {
      secrets,
      limiter: { acquire: vi.fn(async () => true), tryTake: vi.fn(async () => 0) },
      meter,
      clock: fixedClock(NOW),
      logger: createLogger({ service: 'test', level: 'fatal' }),
      perSecond: null,
      policy: () => buildProviderPolicy(),
      monthlyBudgetUsd: async () => null,
    });

  it.each([
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [true, true, true],
  ])('workspace flag %s + acknowledgement %s → usable %s', async (flag, acknowledged, usable) => {
    const flags = { isEnabled: vi.fn(async () => flag) } as unknown as FeatureFlagService;
    const provider = guarded(acknowledged);
    const service = new ProviderSelectionService(
      new ProviderRegistry([provider]),
      flags,
      secrets,
      settings,
      meter,
      fixedClock(NOW),
    );
    const result = await service.select('org-1', { keywords: false, categories: true, tile: 'BBox' });
    expect(result.selected.includes('gmaps_scraper')).toBe(usable);
    if (!usable) expect(result.excluded).toEqual([{ id: 'gmaps_scraper', reason: 'unavailable' }]);
  });

  it('refuses calls without the acknowledgement even if selection is bypassed', async () => {
    const provider = guarded(false);
    const [query] = provider.buildQueries({
      intent: { categoryIds: [], keywords: 'restaurant', languageCode: 'fr' },
      tile: box,
      keysByCategory: new Map(),
      fieldTier: 'pro',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(provider.fetchPage(query as ProviderQuery, context)).rejects.toBeInstanceOf(ForbiddenError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
