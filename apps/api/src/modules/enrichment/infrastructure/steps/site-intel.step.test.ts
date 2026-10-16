import { fixedClock, type SiteIntel, SiteIntelSchema } from '@bf/contracts';
import { BrokenCircuitError, TaskCancelledError } from 'cockatiel';
import { describe, expect, it, vi } from 'vitest';
import type { IntelClient } from '../../../platform/intel/intel-client.ts';
import type { NoSolicitationMarkers, WebsiteSnapshotRepository } from '../../application/ports.ts';
import type { EnrichmentSubject, StepExecution } from '../../domain/enrichment-step.ts';
import { FakeSiteIntel, IntelSiteIntel } from '../site-intel.adapters.ts';
import { SiteIntelStep } from './site-intel.step.ts';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const subject: EnrichmentSubject = {
  businessId: '019a0000-0000-7000-8000-000000000001',
  displayName: 'Salon Ondine',
  websiteUrl: 'https://www.salon-ondine.example/',
  countryCode: 'BL',
  locales: ['fr', 'en'],
  emails: [],
};
const execution = (overrides: Partial<StepExecution> = {}): StepExecution => ({
  runId: '019a0000-0000-7000-8000-0000000000aa',
  stepRowId: 'step',
  organizationId: 'org-1',
  subject,
  inputHash: 'h',
  dependencies: new Map(),
  signal: new AbortController().signal,
  ...overrides,
});

function setup(answer: (url: string) => Promise<SiteIntel>) {
  const analyse = vi.fn(async (request: { url: string }) => answer(request.url));
  const snapshots = {
    insert: vi.fn(async (s: { businessId: string }) => ({ id: 'snap-1', businessId: s.businessId })),
    latest: vi.fn(),
  } as unknown as WebsiteSnapshotRepository;
  const media = { execute: vi.fn(async () => undefined) };
  const markers = { record: vi.fn(async () => undefined) } as unknown as NoSolicitationMarkers & {
    record: ReturnType<typeof vi.fn>;
  };
  const ingest = { execute: vi.fn(async () => ({ changedFields: ['primaryPhone'] })) };
  const step = new SiteIntelStep({
    intel: { analyse },
    snapshots,
    media,
    markers,
    ingest: ingest as never,
    clock: fixedClock(NOW),
    ttlDays: 30,
    costUsd: 0.002,
  });
  return { step, analyse, snapshots, media, ingest, markers };
}

const fake = new FakeSiteIntel(fixedClock(NOW));
const crawl = (url: string) =>
  fake.analyse({ url, artifactPrefix: 'x', localesHint: ['fr'], countryHint: 'BL' });

describe('SiteIntelStep', () => {
  it('applies to businesses with a website, keyed by its address', () => {
    const { step } = setup(crawl);
    expect(step.appliesTo(subject)).toBe(true);
    expect(step.appliesTo({ ...subject, websiteUrl: null })).toBe('no_website');
    expect(step.inputHash(subject)).not.toBe(
      step.inputHash({ ...subject, websiteUrl: 'https://other.example/' }),
    );
    expect(step.estimateCost()).toBe(0.002);
  });

  it('crawls under the run prefix, stores a snapshot and ingests website facts for this business', async () => {
    const { step, analyse, snapshots, media, ingest } = setup(crawl);
    const result = await step.execute(execution());
    expect(analyse).toHaveBeenCalledWith(
      {
        url: subject.websiteUrl,
        artifactPrefix: `sites/${subject.businessId}/019a0000-0000-7000-8000-0000000000aa`,
        localesHint: ['fr', 'en'],
        countryHint: 'BL',
      },
      expect.any(AbortSignal),
    );
    expect(snapshots.insert).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: subject.businessId, url: subject.websiteUrl }),
    );
    expect(ingest.execute).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'website', emails: ['hello@salon-ondine.example'] }),
      { orgId: 'org-1', targetBusinessId: subject.businessId, defaultRegion: 'BL', classifyWithModel: false },
    );
    expect(media.execute).toHaveBeenCalledWith(subject.businessId, expect.any(Array), 'fr');
    expect(result).toEqual({
      outcome: 'done',
      costUsd: 0.002,
      outputRef: {
        snapshotId: 'snap-1',
        reachability: 'ok',
        screenshots: { desktopKey: null, mobileKey: null },
      },
      changedFields: ['primaryPhone'],
    });
  });

  it('records an unreachable site without ingesting anything', async () => {
    const { step, ingest, media, snapshots } = setup(() => crawl('https://down.salon-ondine.example/'));
    const result = await step.execute(execution());
    expect(snapshots.insert).toHaveBeenCalled();
    expect(ingest.execute).not.toHaveBeenCalled();
    expect(media.execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: 'done',
      outputRef: { reachability: 'dns_error' },
      changedFields: [],
    });
  });

  it('keeps a no-solicitation statement as a sticky marker', async () => {
    const { step, markers } = setup(() => crawl('https://nosolicit.salon-ondine.example/'));
    await step.execute(execution());
    expect(markers.record).toHaveBeenCalledWith(
      subject.businessId,
      expect.objectContaining({ phrases: ['no solicitation'], snapshotId: 'snap-1' }),
      NOW,
    );
    const quiet = setup(crawl);
    await quiet.step.execute(execution());
    expect(quiet.markers.record).not.toHaveBeenCalled();
  });

  it('checks an unreachable site again sooner than a readable one', () => {
    const { step } = setup(crawl);
    const crawled = (days: number, reachability: string) => ({
      finishedAt: new Date(NOW.getTime() - days * 24 * 3_600_000),
      inputHash: 'h',
      outputRef: { reachability },
    });
    expect(step.isStale(crawled(10, 'ok'), NOW)).toBe(false);
    expect(step.isStale(crawled(31, 'ok'), NOW)).toBe(true);
    expect(step.isStale(crawled(1, 'dns_error'), NOW)).toBe(false);
    expect(step.isStale(crawled(3, 'dns_error'), NOW)).toBe(true);
  });

  it('hashes what the site says, not when it was read', async () => {
    const { step, snapshots } = setup(crawl);
    await step.execute(execution());
    const later = setup(async (url) => ({
      ...(await crawl(url)),
      fetchedAt: '2026-10-16T08:00:00.000Z',
      durationMs: 5,
    }));
    await later.step.execute(execution());
    const hashOf = (repo: WebsiteSnapshotRepository) =>
      (vi.mocked(repo.insert).mock.calls[0]?.[0] as { contentHash: string } | undefined)?.contentHash;
    expect(hashOf(snapshots)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOf(later.snapshots)).toBe(hashOf(snapshots));
  });
});

describe('site intel adapters', () => {
  it('sends a valid, bounded request with the site policy', async () => {
    const answer = await crawl('https://salon.example/');
    const post = vi.fn(async () => answer);
    const adapter = new IntelSiteIntel({ post } as unknown as IntelClient);
    const signal = new AbortController().signal;
    await adapter.analyse(
      { url: 'https://salon.example/', artifactPrefix: 'sites/a/b', localesHint: ['fr'], countryHint: null },
      signal,
    );
    expect(post).toHaveBeenCalledWith(
      '/v1/site-intel',
      {
        url: 'https://salon.example/',
        artifactPrefix: 'sites/a/b',
        maxPages: 6,
        localesHint: ['fr'],
        screenshots: { desktop: true, mobile: true, fullPage: false },
        timeoutSeconds: 90,
      },
      SiteIntelSchema,
      { policy: 'intel-site', signal },
    );
  });

  it('reports an open circuit and a timeout as typed transient errors', async () => {
    const signal = new AbortController().signal;
    const request = {
      url: 'https://salon.example/',
      artifactPrefix: 'sites/a/b',
      localesHint: ['fr'],
      countryHint: null,
    };
    const open = new IntelSiteIntel({
      post: vi.fn(async () => {
        throw new BrokenCircuitError();
      }),
    } as unknown as IntelClient);
    await expect(open.analyse(request, signal)).rejects.toMatchObject({
      details: { reason: 'circuit_open', retryable: true },
    });
    const slow = new IntelSiteIntel({
      post: vi.fn(async () => {
        throw new TaskCancelledError();
      }),
    } as unknown as IntelClient);
    await expect(slow.analyse(request, signal)).rejects.toMatchObject({
      details: { reason: 'timeout', retryable: true },
    });
  });

  it('fakes a no-solicitation statement on request', async () => {
    const answer = await crawl('https://nosolicit.salon.example/');
    expect(answer.noSolicitation).toMatchObject({ checked: true, detected: true });
  });
});
