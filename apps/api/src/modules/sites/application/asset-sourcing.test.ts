import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fixedClock } from '@bf/contracts';
import type { DbClient } from '@bf/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTransactionalDb } from '../../platform/db/transactional.ts';
import type { EventRecorder } from '../../platform/events/event-recorder.ts';
import type { Logger } from '../../platform/logging/logger.ts';
import { InMemoryObjectStorage } from '../../platform/storage/object-storage.ts';
import { FakeImageAnalyzer, FakeImageFetcher } from '../infrastructure/assets/sourcing.adapters.ts';
import { SharpImageProcessor } from '../infrastructure/sharp-image-processor.ts';
import {
  AssetSourcing,
  type ImageFetcher,
  type OwnerSiteImages,
  type WordmarkMaker,
} from './asset-sourcing.ts';
import type { AssetProcessingQueue, AssetSourcingQueue } from './ports.ts';
import { SiteCommands } from './sites.commands.ts';
import { InMemoryAssets, InMemorySitesRepository } from './testing.ts';

const fixtures = join(
  dirname(createRequire(import.meta.url).resolve('@bf/site-schema/package.json')),
  'fixtures',
);
const salon = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(fixtures, 'salon-gustavia.json'), 'utf8'));
const ORG = '0199e0a0-0000-7000-8000-000000000001';
const actor = { organizationId: ORG, userId: 'user-1' };
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const hosting = { baseDomain: 'sites.test', assetHosts: ['assets.bf-sites.test'] };

const passthroughDb = { transaction: async (fn: (tx: unknown) => unknown) => fn({}) } as unknown as DbClient;
beforeAll(() => setTransactionalDb(passthroughDb));
afterAll(() => setTransactionalDb(undefined));

let sites: InMemorySitesRepository;
let assets: InMemoryAssets;
let originals: InMemoryObjectStorage;
let owner: OwnerSiteImages | undefined;
let fetcher: ImageFetcher & { fetch: ReturnType<typeof vi.fn> };
let processing: AssetProcessingQueue & { process: ReturnType<typeof vi.fn> };
let queue: AssetSourcingQueue & { collect: ReturnType<typeof vi.fn>; analyze: ReturnType<typeof vi.fn> };
let events: { record: ReturnType<typeof vi.fn> };
let sourcing: AssetSourcing;
let siteId: string;

const images = new SharpImageProcessor();
const wordmarks: WordmarkMaker = {
  make: async () => ({
    logo: await images.rasterizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"/>',
      300,
    ),
    favicon: await images.rasterizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"/>',
      64,
    ),
    key: 'k1',
  }),
};

beforeEach(async () => {
  sites = new InMemorySitesRepository();
  assets = new InMemoryAssets();
  originals = new InMemoryObjectStorage();
  owner = {
    images: [
      { url: 'https://salon.example/img/terrasse.jpg', alt: 'Terrasse' },
      { url: 'https://salon.example/img/salon.jpg', alt: null },
      { url: 'https://lh3.googleusercontent.com/p/x=w800', alt: null },
    ],
    logos: [{ url: 'https://salon.example/logo.png' }],
  };
  const fake = new FakeImageFetcher();
  fetcher = { fetch: vi.fn((url: string) => fake.fetch(url)) };
  processing = { process: vi.fn(async () => undefined) };
  queue = { collect: vi.fn(async () => undefined), analyze: vi.fn(async () => undefined) };
  events = { record: vi.fn(async () => ({})) };
  const clock = fixedClock('2026-10-16T12:00:00.000Z');
  sourcing = new AssetSourcing(
    sites,
    assets,
    originals,
    images,
    processing,
    queue,
    { latest: async () => owner },
    fetcher,
    wordmarks,
    new FakeImageAnalyzer(),
    clock,
    events as unknown as EventRecorder,
    logger,
  );
  const commands = new SiteCommands(sites, hosting, clock, logger, events as unknown as EventRecorder);
  const businessId = sites.addBusiness(ORG, 'Salon Lumière', 'Gustavia');
  ({ siteId } = await commands.create(actor, { businessId, spec: salon() }));
  events.record.mockClear();
});

describe('collecting a site’s images', () => {
  it('takes the website’s photos and logo, never a provider photo, as preview-only owner images', async () => {
    const result = await sourcing.collect(ORG, siteId);
    expect(result.added.owner_site).toBe(3);
    expect(result.rejected).toBe(1);
    // The provider photo is never even downloaded.
    expect(fetcher.fetch).not.toHaveBeenCalledWith(expect.stringContaining('googleusercontent'), undefined);
    const rows = [...assets.rows.values()];
    expect(rows.map((row) => row.kind).sort()).toEqual(['image', 'image', 'logo']);
    for (const row of rows) {
      expect(row).toMatchObject({
        license: 'owner_site',
        source: 'owner_site',
        restrictions: ['preview_only'],
        status: 'processing',
      });
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.dhash).toMatch(/^[0-9a-f]{16}$/);
      expect(await originals.get(row.storageKey)).toBeDefined();
    }
    expect(processing.process).toHaveBeenCalledTimes(3);
    // A logo was found: no wordmark.
    expect(rows.some((row) => row.source === 'wordmark')).toBe(false);
  });

  it('is idempotent and skips near-duplicates and images that fail the policy', async () => {
    await sourcing.collect(ORG, siteId);
    const again = await sourcing.collect(ORG, siteId);
    expect(again.added.owner_site).toBe(0);
    expect(assets.rows.size).toBe(3);

    // The same picture under another URL is a duplicate; a thumbnail is too small.
    const same = await new FakeImageFetcher().fetch('https://salon.example/img/terrasse.jpg');
    fetcher.fetch.mockImplementation(async (url: string) =>
      url.includes('copy')
        ? same
        : images.rasterizeSvg('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150"/>', 200),
    );
    owner = {
      images: [
        { url: 'https://salon.example/img/copy.jpg', alt: null },
        { url: 'https://salon.example/thumb.jpg', alt: null },
      ],
      logos: [],
    };
    const third = await sourcing.collect(ORG, siteId);
    expect(third).toMatchObject({ added: { owner_site: 0 }, rejected: 2 });
  });

  it('draws a wordmark and its monogram when the business has no logo', async () => {
    owner = { images: [], logos: [] };
    const result = await sourcing.collect(ORG, siteId);
    expect(result.added.wordmark).toBe(2);
    const marks = [...assets.rows.values()];
    expect(marks.map((row) => [row.kind, row.source, row.license, row.restrictions])).toEqual([
      ['logo', 'wordmark', 'system_generated', []],
      ['logo', 'wordmark', 'system_generated', []],
    ]);
    // Drawn once.
    expect((await sourcing.collect(ORG, siteId)).added.wordmark).toBe(0);
  });

  it('survives a website it cannot download from and a site that is gone', async () => {
    fetcher.fetch.mockRejectedValue(new Error('intel down'));
    const result = await sourcing.collect(ORG, siteId);
    // Three downloads failed, the provider photo was refused.
    expect(result.rejected).toBe(4);
    expect(await sourcing.collect(ORG, '0199e0a0-0000-7000-8000-00000000dead')).toEqual({
      added: { upload: 0, owner_site: 0, stock: 0, ai: 0, wordmark: 0 },
      rejected: 0,
    });
  });
});

describe('analysis, suggestions and ownership', () => {
  async function readyImages() {
    await sourcing.collect(ORG, siteId);
    for (const row of assets.rows.values())
      assets.rows.set(row.id, {
        ...row,
        status: 'ready',
        publicUrl: `https://assets.bf-sites.test/${row.id}.webp`,
      });
    return [...assets.rows.values()];
  }

  it('tags a ready image, keeps its alt texts and records the event', async () => {
    const [photo] = (await readyImages()).filter((row) => row.kind === 'image');
    if (!photo) throw new Error('expected a photo');
    assets.rows.set(photo.id, { ...photo, alt: { fr: 'Ma terrasse' } });
    expect(await sourcing.analyze(photo.id)).toBe('analyzed');
    const analysed = assets.rows.get(photo.id);
    expect(analysed?.analysis).toMatchObject({ depicts: 'interior', quality: 4 });
    expect(analysed?.alt).toEqual({ fr: 'Ma terrasse', en: 'Photo of the business Salon Lumière' });
    expect(events.record).toHaveBeenCalledTimes(1);
    expect(await sourcing.analyze('0199e0a0-0000-7000-8000-00000000dead')).toBe('skipped');
  });

  it('discards an AI image the vision check finds showing people (image policy)', async () => {
    const [photo] = (await readyImages()).filter((row) => row.kind === 'image');
    if (!photo) throw new Error('expected a photo');
    assets.rows.set(photo.id, { ...photo, source: 'ai', license: 'ai_generated', restrictions: [] });
    const spy = vi.spyOn(FakeImageAnalyzer.prototype, 'analyze').mockResolvedValueOnce({
      depicts: 'people',
      containsText: false,
      containsPeople: true,
      identifiablePeople: true,
      quality: 4,
      heroSuitability: 4,
      mood: [],
      alt: { fr: 'Une personne' },
    });
    expect(await sourcing.analyze(photo.id)).toBe('skipped');
    expect(assets.rows.get(photo.id)?.status).toBe('failed');
    spy.mockRestore();
  });

  it('ranks the library for a role with reasons, filtered by source and words', async () => {
    await readyImages();
    const hero = await sourcing.suggestions(actor, siteId, { role: 'hero' });
    expect(hero.items).toHaveLength(2);
    expect(hero.items[0]?.reasons.length).toBeGreaterThan(0);
    expect(hero.items[0]?.restrictions).toEqual(['preview_only']);
    const logos = await sourcing.suggestions(actor, siteId, { role: 'logo' });
    expect(logos.items).toHaveLength(1);
    expect((await sourcing.suggestions(actor, siteId, { role: 'gallery', source: 'stock' })).items).toEqual(
      [],
    );
    await expect(
      sourcing.suggestions({ ...actor, organizationId: 'other' }, siteId, { role: 'hero' }),
    ).rejects.toThrow();
  });

  it('lifts preview_only once the business confirms it owns the image', async () => {
    const [image] = await readyImages();
    if (!image) throw new Error('expected an image');
    const confirmed = await sourcing.confirmOwnership(actor, siteId, image.id, { method: 'claim_form' });
    expect(confirmed.restrictions).toEqual([]);
    expect(confirmed.ownership).toEqual({
      confirmedAt: '2026-10-16T12:00:00.000Z',
      confirmedBy: 'user-1',
      method: 'claim_form',
    });
    expect(events.record).toHaveBeenCalledTimes(1);
    // Idempotent.
    await sourcing.confirmOwnership(actor, siteId, image.id, { method: 'email' });
    expect(events.record).toHaveBeenCalledTimes(1);
    await expect(
      sourcing.confirmOwnership(actor, siteId, '0199e0a0-0000-7000-8000-00000000dead', { method: 'email' }),
    ).rejects.toThrow();
  });

  it('queues a refresh for the workspace’s own site only', async () => {
    await sourcing.refresh(actor, siteId);
    expect(queue.collect).toHaveBeenCalledWith(ORG, siteId);
    await expect(sourcing.refresh({ ...actor, organizationId: 'other' }, siteId)).rejects.toThrow();
  });
});
