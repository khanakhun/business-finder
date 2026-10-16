import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type AiGateway, AiOutputInvalidError } from '@bf/ai';
import {
  ExternalServiceError,
  fixedClock,
  type PsiStrategyResult,
  RateLimitedError,
  ValidationError,
} from '@bf/contracts';
import { createLogger } from '@bf/observability';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WebsiteSnapshotRecord } from '../application/ports.ts';
import { StepDeferredError, type StepExecution } from '../domain/enrichment-step.ts';
import { PageSpeedClient, toPsiStrategyResult } from './pagespeed.ts';
import { PSI_MAX_DEFERRALS, PsiStep, VisionAuditStep } from './steps/website-audit.steps.ts';
import { FakeVisionGrader, imageType, LlmVisionGrader } from './vision-graders.ts';
import { analysableUrl, contextUrl } from './website-url.ts';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const clock = fixedClock(NOW);
const logger = createLogger({ service: 'test', level: 'fatal' });
const fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/pagespeed/mobile.json', import.meta.url), 'utf8'),
) as unknown;

describe('toPsiStrategyResult', () => {
  it('keeps the four scores, six lab metrics, field INP and the top opportunities', () => {
    expect(toPsiStrategyResult(fixture, NOW)).toEqual({
      scores: { performance: 38, accessibility: 81, bestPractices: 74, seo: 92 },
      metrics: {
        lcpMs: 5234.7,
        cls: 0.127,
        tbtMs: 640,
        fcpMs: 2810.2,
        speedIndexMs: 6020.4,
        ttfbMs: 412,
        inpMs: 240,
      },
      opportunities: [
        {
          id: 'uses-optimized-images',
          title: 'Efficiently encode images',
          savingsMs: 1650,
          savingsBytes: 912345,
        },
        {
          id: 'render-blocking-resources',
          title: 'Eliminate render-blocking resources',
          savingsMs: 780,
          savingsBytes: null,
        },
      ],
      lighthouseVersion: '12.2.1',
      fetchedAt: '2026-10-14T11:58:00.000Z',
    });
  });

  it('tolerates missing parts and refuses a non-Lighthouse answer', () => {
    expect(
      toPsiStrategyResult({ lighthouseResult: { categories: { seo: { score: null } } } }, NOW),
    ).toMatchObject({
      scores: { performance: null, seo: null },
      metrics: { lcpMs: null, inpMs: null },
      opportunities: [],
      fetchedAt: NOW.toISOString(),
    });
    expect(() => toPsiStrategyResult({ unexpected: true }, NOW)).toThrow(ExternalServiceError);
  });
});

describe('PageSpeedClient', () => {
  let server: Server;
  let base: string;
  let answer: (url: URL) => { status: number; body: unknown; headers?: Record<string, string> };
  const seen: URL[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://local');
      seen.push(url);
      const { status, body, headers } = answer(url);
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/runPagespeed`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('asks for every category and the strategy, with the key', async () => {
    answer = () => ({ status: 200, body: fixture });
    const result = await new PageSpeedClient(clock, base).run('https://bistro.example/', 'mobile', {
      key: 'psi-key',
      signal: new AbortController().signal,
    });
    expect(result.scores.performance).toBe(38);
    const url = seen.at(-1) as URL;
    expect(url.searchParams.get('url')).toBe('https://bistro.example/');
    expect(url.searchParams.get('strategy')).toBe('MOBILE');
    expect(url.searchParams.getAll('category')).toEqual([
      'PERFORMANCE',
      'ACCESSIBILITY',
      'BEST_PRACTICES',
      'SEO',
    ]);
    expect(url.searchParams.get('key')).toBe('psi-key');
  });

  it('maps quota, bad key and unloadable pages to typed errors without the URL', async () => {
    const client = new PageSpeedClient(clock, base);
    const run = () =>
      client.run('https://bistro.example/', 'desktop', { key: 'k', signal: new AbortController().signal });
    answer = () => ({ status: 429, body: {}, headers: { 'Retry-After': '30' } });
    await expect(run()).rejects.toBeInstanceOf(RateLimitedError);
    answer = () => ({
      status: 400,
      body: { error: { message: 'API key not valid. Please pass a valid API key.' } },
    });
    await expect(run()).rejects.toMatchObject({ details: { reason: 'KEY_INVALID', retryable: false } });
    answer = () => ({
      status: 400,
      body: { error: { message: 'Lighthouse returned error: FAILED_DOCUMENT_REQUEST' } },
    });
    const failed = await run().catch((e: unknown) => e);
    expect(failed).toMatchObject({ details: { reason: 'PAGE_FAILED' } });
    expect(String((failed as Error).message)).not.toContain('bistro');
    // Lighthouse's own failures often come as a 500: this site's problem, not an outage (no retry, no breaker).
    answer = () => ({
      status: 500,
      body: { error: { message: 'Lighthouse returned error: NO_FCP. The page did not paint any content.' } },
    });
    await expect(run()).rejects.toMatchObject({ details: { reason: 'PAGE_FAILED', retryable: false } });
    answer = () => ({ status: 403, body: {} });
    await expect(run()).rejects.toMatchObject({ details: { reason: 'FORBIDDEN', retryable: false } });
  });
});

const snapshot = (overrides: Partial<WebsiteSnapshotRecord['intel']> = {}): WebsiteSnapshotRecord => ({
  id: 'snap-1',
  businessId: 'biz-1',
  url: 'https://bistro.example/',
  fetchedAt: NOW,
  contentHash: 'h',
  intel: {
    finalUrl: 'https://bistro.example/',
    reachability: 'ok',
    socialOnly: false,
    screenshots: { desktopKey: null, mobileKey: null, fullPageKey: null },
    ...overrides,
  } as WebsiteSnapshotRecord['intel'],
});

const execution = (overrides: Partial<StepExecution> = {}): StepExecution => ({
  runId: 'run',
  stepRowId: 'row',
  organizationId: 'org',
  subject: {
    businessId: 'biz-1',
    displayName: 'Bistro',
    websiteUrl: 'https://bistro.example/',
    countryCode: 'BL',
    locales: ['fr'],
    emails: [],
  },
  inputHash: 'h',
  dependencies: new Map([
    ['site_intel', { finishedAt: NOW, inputHash: null, outputRef: { snapshotId: 'snap-1' } }],
  ]),
  signal: new AbortController().signal,
  deferrals: 0,
  ...overrides,
});

const result = (performance: number): PsiStrategyResult => ({
  ...toPsiStrategyResult(fixture, NOW),
  scores: { performance, accessibility: 90, bestPractices: 90, seo: 90 },
});

function psiSetup(run: (strategy: string) => Promise<PsiStrategyResult>, wait = 0) {
  const record = vi.fn(async (_snapshot: WebsiteSnapshotRecord, part: object) => ({
    id: 'audit-1',
    websiteStatus: 'ok' as const,
    qualityScore: 70,
    part,
  }));
  const tryTake = vi.fn(async () => wait);
  const step = new PsiStep({
    snapshots: { byId: async () => snapshot(), latest: async () => snapshot() },
    pagespeed: { run: (_url, strategy) => run(strategy) },
    audits: { record: record as never },
    key: async () => 'psi-key',
    limiter: { tryTake },
    quota: { perMinute: 200, perDay: 24_000 },
    clock,
    logger,
    ttlDays: 30,
    random: () => 0,
  });
  return { step, record, tryTake };
}

describe('PsiStep', () => {
  it('measures both strategies and records them', async () => {
    const { step, record, tryTake } = psiSetup(async (strategy) => result(strategy === 'mobile' ? 40 : 80));
    const outcome = await step.execute(execution());
    expect(outcome).toMatchObject({ outcome: 'done', costUsd: 0, changedFields: ['website_audit'] });
    expect(record.mock.calls[0]?.[1]).toMatchObject({
      psi: { mobile: { scores: { performance: 40 } }, desktop: { scores: { performance: 80 } } },
    });
    // Two runs at once (all or none) from the minute bucket, then from the day bucket of this key.
    expect(tryTake.mock.calls).toEqual([
      [expect.stringMatching(/^psi:[0-9a-f]{16}:minute$/), { capacity: 200, perSecond: 200 / 60, cost: 2 }],
      [
        expect.stringMatching(/^psi:[0-9a-f]{16}:day$/),
        { capacity: 24_000, perSecond: 24_000 / 86_400, cost: 2 },
      ],
    ]);
    expect(step.appliesTo({ ...execution().subject, websiteUrl: null })).toBe('no_website');
  });

  it('defers on an empty quota bucket before calling, then gives up for this run', async () => {
    const run = vi.fn(async () => result(50));
    const { step, tryTake } = psiSetup(run, 300);
    const deferred = await step.execute(execution()).catch((e: unknown) => e);
    expect(deferred).toBeInstanceOf(StepDeferredError);
    // The minute bucket was empty: the day bucket is left alone.
    expect(tryTake).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    // At least the bucket's wait, backing off to a minute with each deferral (bulk runs drain over minutes).
    expect((deferred as StepDeferredError).retryAfterMs).toBe(1_000);
    const later = await step.execute(execution({ deferrals: 4 })).catch((e: unknown) => e);
    expect((later as StepDeferredError).retryAfterMs).toBe(16_000);
    const last = await step.execute(execution({ deferrals: PSI_MAX_DEFERRALS - 1 })).catch((e: unknown) => e);
    expect((last as StepDeferredError).retryAfterMs).toBe(60_000);
    expect(await step.execute(execution({ deferrals: PSI_MAX_DEFERRALS }))).toMatchObject({
      outcome: 'done',
      outputRef: { measured: false, quota: true, recheckAt: expect.any(String) },
    });
  });

  it('never measures a snapshot of another business named by the dependency', async () => {
    const run = vi.fn(async () => result(50));
    const { step, record } = psiSetup(run);
    (step as unknown as { options: { snapshots: unknown } }).options.snapshots = {
      byId: async () => ({ ...snapshot(), id: 'snap-other', businessId: 'biz-2' }),
      latest: async () => snapshot(),
    };
    await step.execute(execution());
    expect(record.mock.calls[0]?.[0]).toMatchObject({ businessId: 'biz-1' });
  });

  it('never measures a blocked crawl (robots opt-out, refused address); spends no quota on an IP host', async () => {
    const run = vi.fn(async () => result(50));
    const { step, record, tryTake } = psiSetup(run);
    (step as unknown as { options: { snapshots: unknown } }).options.snapshots = {
      byId: async () => snapshot({ reachability: 'blocked' }),
      latest: async () => undefined,
    };
    expect(await step.execute(execution())).toMatchObject({
      outcome: 'done',
      outputRef: { measured: false },
    });
    expect(run).not.toHaveBeenCalled();
    expect(tryTake).not.toHaveBeenCalled();
    expect(record.mock.calls[0]?.[1]).toEqual({});
    const ip = psiSetup(run);
    (ip.step as unknown as { options: { snapshots: unknown } }).options.snapshots = {
      byId: async () => snapshot({ finalUrl: 'http://203.0.113.7/' }),
      latest: async () => undefined,
    };
    expect(await ip.step.execute(execution())).toMatchObject({ outputRef: { measured: false } });
    expect(ip.tryTake).not.toHaveBeenCalled();
  });

  it('records the audit without measuring an unreachable site', async () => {
    const run = vi.fn(async () => result(50));
    const { step, record } = psiSetup(run);
    (step as unknown as { options: { snapshots: unknown } }).options.snapshots = {
      byId: async () => snapshot({ reachability: 'dns_error' }),
      latest: async () => undefined,
    };
    expect(await step.execute(execution())).toMatchObject({
      outcome: 'done',
      outputRef: { measured: false },
    });
    expect(run).not.toHaveBeenCalled();
    expect(record.mock.calls[0]?.[1]).toEqual({});
  });

  it('keeps one strategy when the other is down, and re-checks', async () => {
    const { step, record } = psiSetup(async (strategy) => {
      if (strategy === 'desktop') throw new ExternalServiceError('pagespeed', 'answered 503');
      return result(45);
    });
    expect(await step.execute(execution())).toMatchObject({
      outcome: 'done',
      outputRef: { measured: true, recheckAt: expect.any(String) },
    });
    expect(record.mock.calls[0]?.[1]).toMatchObject({
      psi: { mobile: { scores: { performance: 45 } }, desktop: null },
    });
  });

  it('never rethrows outages or quotas; shows a refused key; accepts a page Lighthouse cannot load', async () => {
    const down = psiSetup(async () => {
      throw new RateLimitedError('quota', 60);
    });
    expect(await down.step.execute(execution())).toMatchObject({
      outcome: 'done',
      outputRef: { measured: false, recheckAt: expect.any(String) },
    });
    const refused = psiSetup(async () => {
      throw new ExternalServiceError('pagespeed', 'answered 400', {
        details: { reason: 'KEY_INVALID', retryable: false },
      });
    });
    await expect(refused.step.execute(execution())).rejects.toMatchObject({
      details: { reason: 'KEY_INVALID' },
    });
    const page = psiSetup(async () => {
      throw new ExternalServiceError('pagespeed', 'answered 400', {
        details: { reason: 'PAGE_FAILED', retryable: false },
      });
    });
    const outcome = await page.step.execute(execution());
    expect(outcome).toMatchObject({ outcome: 'done', outputRef: { measured: false } });
    expect((outcome as { outputRef: Record<string, unknown> }).outputRef.recheckAt).toBeUndefined();
  });
});

describe('VisionAuditStep', () => {
  const setup = (grade: (snapshot: WebsiteSnapshotRecord) => Promise<unknown>) => {
    const record = vi.fn(async () => ({ id: 'audit-1', websiteStatus: 'ok' as const, qualityScore: 70 }));
    const step = new VisionAuditStep({
      snapshots: { byId: async () => snapshot(), latest: async () => snapshot() },
      grader: { grade: (_org, s) => grade(s) as never },
      audits: { record: record as never, categoryLabel: async () => 'Restaurant' },
      clock,
      logger,
      ttlDays: 30,
      costUsd: 0.02,
    });
    return { step, record };
  };

  it('records the grade and books its cost; nothing to grade is not an error', async () => {
    const fake = new FakeVisionGrader(clock);
    const { step, record } = setup(async (s) => ({ ...(await fake.grade('org', s)), costUsd: 0.013 }));
    expect(await step.execute(execution())).toMatchObject({
      outcome: 'done',
      costUsd: 0.013,
      outputRef: { graded: true },
    });
    expect(record).toHaveBeenCalledWith(expect.anything(), {
      vision: expect.objectContaining({ overall: 8 }),
    });
    expect(step.dependsOn).toEqual(['site_intel', 'psi']);
    expect(step.optionalDependencies).toEqual(['psi']);
    const none = setup(async () => null);
    expect(await none.step.execute(execution())).toMatchObject({
      outcome: 'done',
      costUsd: 0,
      outputRef: { graded: false },
    });
  });

  it('re-checks a model outage, and shows a configuration error', async () => {
    const outage = setup(async () => {
      throw new ExternalServiceError('llm', 'no model provider is available', {
        details: { reason: 'AI_UNAVAILABLE' },
      });
    });
    expect(await outage.step.execute(execution())).toMatchObject({
      outcome: 'done',
      outputRef: { graded: false, recheckAt: expect.any(String) },
    });
    const config = setup(async () => {
      throw new ValidationError('No anthropic API key is configured.');
    });
    await expect(config.step.execute(execution())).rejects.toBeInstanceOf(ValidationError);
  });

  it('books what an invalid (but billed) answer cost, and re-checks', async () => {
    const invalid = setup(async () => {
      throw Object.assign(new AiOutputInvalidError('website.vision_grade'), { costUsd: 0.011 });
    });
    expect(await invalid.step.execute(execution())).toMatchObject({
      outcome: 'done',
      costUsd: 0.011,
      outputRef: { graded: false, recheckAt: expect.any(String) },
    });
  });

  it('never grades a blocked crawl (its screenshots show the block page)', async () => {
    const grade = vi.fn(async () => null);
    const { step } = setup(grade);
    (step as unknown as { options: { snapshots: unknown } }).options.snapshots = {
      byId: async () => snapshot({ reachability: 'blocked' }),
      latest: async () => undefined,
    };
    expect(await step.execute(execution())).toMatchObject({ outcome: 'done', outputRef: { graded: false } });
    expect(grade).not.toHaveBeenCalled();
  });
});

describe('screenshot and URL guards', () => {
  it('recognizes images by their bytes', () => {
    expect(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(imageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('image/png');
    expect(imageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(imageType(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
  });

  it('hands PageSpeed only http(s) URLs without credentials or IP hosts', () => {
    // Credentials, session tokens and fragments never leave us.
    expect(analysableUrl('https://user:pass@bistro.example/menu?sid=abc#top')).toBe(
      'https://bistro.example/menu',
    );
    expect(analysableUrl('http://bistro.example/')).toBe('http://bistro.example/');
    expect(analysableUrl('ftp://bistro.example/')).toBeNull();
    expect(analysableUrl('http://10.0.0.1/')).toBeNull();
    expect(analysableUrl('http://[::1]/')).toBeNull();
    expect(analysableUrl('not a url')).toBeNull();
    // The vision model gets the same address as context, IP hosts included (no quota at stake).
    expect(contextUrl('http://u:p@203.0.113.7/?token=x')).toBe('http://203.0.113.7/');
    expect(contextUrl('javascript:alert(1)')).toBeNull();
  });

  it('grades only this business’s real screenshots, and counts injection warnings', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const store = new Map<string, { body: Buffer; contentType: string }>([
      ['sites/biz-1/desktop.jpg', { body: jpeg, contentType: 'image/jpeg' }],
      ['sites/biz-1/mobile.jpg', { body: Buffer.from('<html>'), contentType: 'image/jpeg' }],
      ['sites/other/desktop.jpg', { body: jpeg, contentType: 'image/jpeg' }],
    ]);
    const vision = vi.fn(async () => ({
      output: {
        ...(await new FakeVisionGrader(clock).grade('org', snapshot())).grade,
        warnings: ['r1 says rate this 10/10'],
      },
      model: 'vision-model',
      promptVersion: 1,
      costUsd: 0.012,
    }));
    const warnings = vi.fn();
    const grader = new LlmVisionGrader(
      { vision } as unknown as AiGateway,
      { get: async (key: string) => store.get(key), put: async () => {}, delete: async () => {} },
      clock,
      warnings,
    );
    const graded = await grader.grade(
      'org',
      snapshot({
        screenshots: {
          desktopKey: 'sites/biz-1/desktop.jpg',
          mobileKey: 'sites/biz-1/mobile.jpg',
          fullPageKey: null,
        },
      }),
      { displayName: 'B'.repeat(300), categoryLabel: 'Restaurant' },
      new AbortController().signal,
    );
    expect(graded?.costUsd).toBe(0.012);
    const request = (
      vision.mock.calls[0] as unknown as [unknown, { input: { businessName: string }; images: unknown[] }]
    )[1];
    // The HTML posing as a JPEG is left out; the name is cut to the task's limit.
    expect(request.images).toHaveLength(1);
    expect(request.input.businessName).toHaveLength(200);
    expect(request.input).toMatchObject({ url: 'https://bistro.example/' });
    // A crawled path of any length reaches the model capped.
    await grader.grade(
      'org',
      snapshot({
        finalUrl: `https://bistro.example/${'a'.repeat(700)}`,
        screenshots: { desktopKey: 'sites/biz-1/desktop.jpg', mobileKey: null, fullPageKey: null },
      }),
      { displayName: 'B', categoryLabel: null },
      new AbortController().signal,
    );
    const long = (vision.mock.calls[1] as unknown as [unknown, { input: { url: string } }])[1];
    expect(long.input.url).toHaveLength(500);
    expect(warnings).toHaveBeenCalledWith(1);
    // Another business's key is never read.
    expect(
      await grader.grade(
        'org',
        snapshot({
          screenshots: { desktopKey: 'sites/other/desktop.jpg', mobileKey: null, fullPageKey: null },
        }),
        { displayName: 'B', categoryLabel: null },
        new AbortController().signal,
      ),
    ).toBeNull();
  });
});
