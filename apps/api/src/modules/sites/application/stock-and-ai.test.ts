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
import { FakeImageGenerator } from '../infrastructure/assets/ai-image.adapters.ts';
import { FakeImageFetcher } from '../infrastructure/assets/sourcing.adapters.ts';
import { FakeStockProvider } from '../infrastructure/assets/stock.adapters.ts';
import { SharpImageProcessor } from '../infrastructure/sharp-image-processor.ts';
import type { AssetProcessingQueue } from './ports.ts';
import { SiteCommands } from './sites.commands.ts';
import {
  type AiImageAllowance,
  type GenerationQueue,
  StockAndAiImages,
  type StockPhoto,
  type StockProvider,
  unsplashSized,
  withReferral,
} from './stock-and-ai.ts';
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
const events = { record: vi.fn(async () => ({})) } as unknown as EventRecorder;

/** A Pexels-like provider (copied, not hotlinked), its photo served by the fake fetcher. */
class FakePexels implements StockProvider {
  readonly name = 'pexels' as const;
  async available() {
    return true;
  }
  photoFor(id: string): StockPhoto {
    return {
      provider: 'pexels',
      id,
      previewUrl: `https://images.pexels.com/photos/${id}/medium.jpeg`,
      imageUrl: `https://images.pexels.com/photos/${id}/photo.jpeg?w=1920`,
      width: 1920,
      height: 1280,
      author: 'Lee Pexels',
      authorUrl: 'https://www.pexels.com/@lee',
      pageUrl: `https://www.pexels.com/photo/${id}/`,
      alt: 'linen texture',
      color: '#efe7d8',
      downloadLocation: null,
    };
  }
  async search() {
    return [this.photoFor('42')];
  }
  async photo(_org: string, id: string) {
    return id === '42' ? this.photoFor(id) : undefined;
  }
  async trackDownload() {}
}

const passthroughDb = { transaction: async (fn: (tx: unknown) => unknown) => fn({}) } as unknown as DbClient;
beforeAll(() => setTransactionalDb(passthroughDb));
afterAll(() => setTransactionalDb(undefined));

let assets: InMemoryAssets;
let unsplash: FakeStockProvider;
let processing: AssetProcessingQueue & { process: ReturnType<typeof vi.fn> };
let generations: GenerationQueue & { generate: ReturnType<typeof vi.fn> };
let allowance: AiImageAllowance &
  Record<'budget' | 'usedToday' | 'reserve' | 'record', ReturnType<typeof vi.fn>>;
let images: StockAndAiImages;
let siteId: string;

beforeEach(async () => {
  const sites = new InMemorySitesRepository();
  assets = new InMemoryAssets();
  unsplash = new FakeStockProvider();
  processing = { process: vi.fn(async () => undefined) };
  generations = { generate: vi.fn(async () => undefined) };
  let used = 0;
  allowance = {
    budget: vi.fn(async () => 'ok' as const),
    usedToday: vi.fn(async () => used),
    reserve: vi.fn(async (_org: string, count: number, cap: number) => {
      if (used + count > cap) return false;
      used += count;
      return true;
    }),
    record: vi.fn(async () => undefined),
  };
  const clock = fixedClock('2026-10-16T12:00:00.000Z');
  images = new StockAndAiImages(
    sites,
    assets,
    new InMemoryObjectStorage(),
    new SharpImageProcessor(),
    processing,
    new FakeImageFetcher(),
    [unsplash, new FakePexels()],
    new FakeImageGenerator(),
    allowance,
    { dailyCap: 4, priceUsd: 0.06, unsplashAppName: 'business_finder' },
    generations,
    clock,
    logger,
  );
  const commands = new SiteCommands(
    sites,
    { baseDomain: 'sites.test', assetHosts: ['assets.bf-sites.test'] },
    clock,
    logger,
    events,
  );
  const businessId = sites.addBusiness(ORG, 'Salon Lumière', 'Gustavia');
  ({ siteId } = await commands.create(actor, { businessId, spec: salon() }));
});

describe('stock photos', () => {
  it('lists the configured providers and today’s AI allowance', async () => {
    expect(await images.sources(actor, siteId)).toEqual({
      stock: ['unsplash', 'pexels'],
      ai: { enabled: true, remainingToday: 4 },
    });
    allowance.budget.mockResolvedValueOnce('hard');
    expect((await images.sources(actor, siteId)).ai).toEqual({ enabled: false, remainingToday: 0 });
  });

  it('searches every provider and credits each photo per its licence', async () => {
    const found = await images.search(actor, siteId, 'turquoise sea');
    expect(found.map((candidate) => candidate.provider)).toEqual([
      'unsplash',
      'unsplash',
      'unsplash',
      'pexels',
    ]);
    expect(found[0]).toMatchObject({ source: 'stock', license: 'stock', assetId: null });
    expect(found[0]?.attribution).toBe('Photo by Ana Example on Unsplash');
    expect(found.at(-1)?.attribution).toBe('Photo by Lee Pexels on Pexels');
  });

  it('hotlinks an Unsplash photo, tracks its download once, with referral links; idempotent', async () => {
    const [candidate] = await images.search(actor, siteId, 'sea');
    if (!candidate) throw new Error('expected a candidate');
    const asset = await images.importStock(actor, siteId, candidate.id);
    expect(asset).toMatchObject({ status: 'ready', hosting: 'hotlink', license: 'stock', source: 'stock' });
    expect(asset.publicUrl).toMatch(/^https:\/\/images\.unsplash\.com\/.*w=1200/);
    expect(asset.variants).toEqual([]);
    expect(asset.licenseDetails?.authorUrl).toBe(
      'https://unsplash.com/@ana_example?utm_source=business_finder&utm_medium=referral',
    );
    expect(unsplash.tracked).toHaveLength(1);
    expect(processing.process).not.toHaveBeenCalled();
    // Picked again: the same image, no second download tracked.
    const again = await images.importStock(actor, siteId, candidate.id);
    expect(again.id).toBe(asset.id);
    expect(unsplash.tracked).toHaveLength(1);
  });

  it('copies a Pexels photo through the guarded download and processes it', async () => {
    const asset = await images.importStock(actor, siteId, 'stock:pexels:42');
    expect(asset).toMatchObject({ status: 'processing', hosting: 'self', license: 'stock' });
    expect(asset.licenseDetails?.attributionText).toBe('Photo by Lee Pexels on Pexels');
    expect(processing.process).toHaveBeenCalledTimes(1);
    await expect(images.importStock(actor, siteId, 'stock:pexels:404')).rejects.toThrow();
    await expect(images.importStock(actor, siteId, 'stock:flickr:1')).rejects.toThrow(/not configured/);
  });

  it('keeps Unsplash URLs resizable and links carrying the referral', () => {
    expect(unsplashSized('https://images.unsplash.com/photo-1?ixid=abc', 768)).toBe(
      'https://images.unsplash.com/photo-1?ixid=abc&w=768&q=80&fm=jpg&fit=max',
    );
    expect(withReferral('https://unsplash.com/@a', 'bf')).toBe(
      'https://unsplash.com/@a?utm_source=bf&utm_medium=referral',
    );
    expect(withReferral('not a url', 'bf')).toBe('not a url');
  });
});

describe('AI images', () => {
  it('refuses prompts against the policy, an exhausted budget and today’s cap', async () => {
    await expect(
      images.generate(actor, siteId, { prompt: 'a smiling chef', aspect: '16:9', count: 2 }),
    ).rejects.toThrow(/illustrations only/);
    allowance.budget.mockResolvedValueOnce('hard');
    await expect(
      images.generate(actor, siteId, { prompt: 'turquoise sea', aspect: '16:9', count: 2 }),
    ).rejects.toThrow(/budget/);
    await images.generate(actor, siteId, { prompt: 'turquoise sea', aspect: '16:9', count: 2 });
    await images.generate(actor, siteId, { prompt: 'linen texture', aspect: '1:1', count: 2 });
    await expect(
      images.generate(actor, siteId, { prompt: 'palm shadows', aspect: '1:1', count: 1 }),
    ).rejects.toThrow(/used up/);
    expect(generations.generate).toHaveBeenCalledTimes(2);
  });

  it('stores generated images as AI illustrations, records the cost, once per generation', async () => {
    const { generationId } = await images.generate(actor, siteId, {
      prompt: 'turquoise sea',
      aspect: '16:9',
      count: 2,
    });
    const input = {
      organizationId: ORG,
      siteId,
      generationId,
      prompt: 'turquoise sea',
      aspect: '16:9' as const,
      count: 2,
    };
    expect(await images.runGeneration(input)).toBe(2);
    const rows = [...assets.rows.values()];
    expect(rows.map((row) => [row.source, row.license, row.status])).toEqual([
      ['ai', 'ai_generated', 'processing'],
      ['ai', 'ai_generated', 'processing'],
    ]);
    expect(rows[0]?.licenseDetails).toMatchObject({ provider: 'openai', model: 'fake-image' });
    expect(allowance.record).toHaveBeenCalledWith(
      expect.objectContaining({ images: 2, costUsd: 0.12, status: 'ok' }),
    );
    // A redelivered job does nothing (and costs nothing).
    expect(await images.runGeneration(input)).toBe(0);
    expect(allowance.record).toHaveBeenCalledTimes(1);
  });
});
