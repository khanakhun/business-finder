import { createHash } from 'node:crypto';
import { fixedClock } from '@bf/contracts';
import type { DbClient } from '@bf/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setTransactionalDb } from '../../platform/db/transactional.ts';
import { InMemoryObjectStorage } from '../../platform/storage/object-storage.ts';
import { InMemoryPublicFiles } from '../infrastructure/site-asset-storage.ts';
import type { AssetStatus, ImageProcessor, SiteAssetsRepository, StoredAsset } from './ports.ts';
import { SiteAssetCommands, variantWidths } from './site-assets.ts';
import { InMemorySitesRepository } from './testing.ts';

const ORG = '0199e0a0-0000-7000-8000-000000000001';
const actor = { organizationId: ORG, userId: null };
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(56, 1),
]);

/** Site assets in memory, with the compare-and-set the database applies. */
class InMemoryAssets implements SiteAssetsRepository {
  readonly rows = new Map<string, StoredAsset>();
  async insert(asset: Parameters<SiteAssetsRepository['insert']>[0]): Promise<StoredAsset> {
    const { createdBy: _createdBy, ...rest } = asset;
    const row: StoredAsset = {
      ...rest,
      status: 'pending',
      width: null,
      height: null,
      publicUrl: null,
      variants: null,
      dominantColors: null,
      sha256: null,
      processingStartedAt: null,
      createdAt: new Date('2026-10-14T12:00:00.000Z'),
    };
    this.rows.set(row.id, row);
    return row;
  }
  async get(organizationId: string, siteId: string, assetId: string) {
    const row = this.rows.get(assetId);
    return row?.organizationId === organizationId && row.siteId === siteId ? row : undefined;
  }
  async byId(assetId: string) {
    return this.rows.get(assetId);
  }
  async list() {
    return [...this.rows.values()];
  }
  lock(organizationId: string, siteId: string, assetId: string) {
    return this.get(organizationId, siteId, assetId);
  }
  async failStale(cutoffs: { startedBefore: Date; createdBefore: Date }) {
    const stale = [...this.rows.values()].filter(
      (row) =>
        row.status === 'processing' &&
        (row.processingStartedAt
          ? row.processingStartedAt < cutoffs.startedBefore
          : row.createdAt < cutoffs.createdBefore),
    );
    for (const row of stale) this.rows.set(row.id, { ...row, status: 'failed' });
    return stale;
  }
  async transition(
    assetId: string,
    from: readonly AssetStatus[],
    changes: Partial<StoredAsset>,
    startedAt?: Date,
  ) {
    const row = this.rows.get(assetId);
    if (!row || !from.includes(row.status)) return false;
    if (startedAt && row.processingStartedAt?.getTime() !== startedAt.getTime()) return false;
    this.rows.set(assetId, { ...row, ...changes });
    return true;
  }
  async referenced() {
    return false;
  }
  async delete(assetId: string) {
    this.rows.delete(assetId);
  }
}

const images: ImageProcessor = {
  inspect: async () => ({ width: 1000, height: 600 }),
  variants: async (_image, widths) =>
    widths.flatMap((width) => [
      { width, format: 'webp' as const, body: Buffer.from(`webp-${width}`) },
      { width, format: 'avif' as const, body: Buffer.from(`avif-${width}`) },
    ]),
  dominantColors: async () => ['#c2410c'],
};

const fakeDb = { transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({}) } as unknown as DbClient;
beforeAll(() => setTransactionalDb(fakeDb));
afterAll(() => setTransactionalDb(undefined));

let sites: InMemorySitesRepository;
let assets: InMemoryAssets;
let originals: InMemoryObjectStorage;
let publicFiles: InMemoryPublicFiles;
let queued: string[];
let commands: SiteAssetCommands;
let siteId: string;

beforeEach(async () => {
  sites = new InMemorySitesRepository();
  assets = new InMemoryAssets();
  originals = new InMemoryObjectStorage();
  publicFiles = new InMemoryPublicFiles();
  queued = [];
  commands = new SiteAssetCommands(
    sites,
    assets,
    { presignPut: async (key) => ({ url: `https://uploads.test/${key}`, headers: {} }) },
    originals,
    publicFiles,
    images,
    { process: async (assetId) => void queued.push(assetId) },
    fixedClock('2026-10-14T12:00:00.000Z'),
    fakeDb,
  );
  const businessId = sites.addBusiness(ORG, 'Salon');
  siteId = 'f'.repeat(8).concat('-0000-7000-8000-000000000001');
  await sites.insertSite({
    id: siteId,
    organizationId: ORG,
    businessId,
    slug: 'salon-k3x9p2',
    defaultLocale: 'fr',
    createdBy: null,
  } as never);
});

async function uploaded(bytes = PNG) {
  const { asset } = await commands.createUpload(actor, siteId, {
    mime: 'image/png',
    bytes: bytes.length,
    license: 'uploaded',
  });
  const stored = assets.rows.get(asset.id);
  await originals.put(stored?.storageKey ?? '', bytes, 'image/png');
  return asset.id;
}

describe('variantWidths', () => {
  it('publishes the steps an image reaches and its own width below the largest, never enlarging it', () => {
    expect(variantWidths(300)).toEqual([300]);
    expect(variantWidths(768)).toEqual([480, 768]);
    expect(variantWidths(1000)).toEqual([480, 768, 1000]);
    expect(variantWidths(4000)).toEqual([480, 768, 1200, 1920]);
  });
});

describe('SiteAssetCommands', () => {
  it('lets one of two overlapping finalizes queue the job; the other answers with its result', async () => {
    const id = await uploaded();
    const [first, second] = await Promise.all([
      commands.finalize(actor, siteId, id),
      commands.finalize(actor, siteId, id),
    ]);
    expect([first.status, second.status]).toEqual(['processing', 'processing']);
    expect(queued).toEqual([id]);
    expect(await commands.process(id)).toBe('ready');
    // A late finalize never moves a ready image back.
    expect((await commands.finalize(actor, siteId, id)).status).toBe('ready');
    expect(assets.rows.get(id)?.status).toBe('ready');
  });

  it('processes only the bytes finalize checked: an original replaced since is refused', async () => {
    const id = await uploaded();
    await commands.finalize(actor, siteId, id);
    const swapped = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(56, 2)]);
    await originals.put(assets.rows.get(id)?.storageKey ?? '', swapped, 'image/png');
    expect(await commands.process(id)).toBe('failed');
    expect(assets.rows.get(id)?.status).toBe('failed');
    expect(publicFiles.files.size).toBe(0);
    expect(assets.rows.get(id)?.sha256).toBe(createHash('sha256').update(PNG).digest('hex'));
  });

  it('removes the variants it wrote when the image was deleted while it ran', async () => {
    const id = await uploaded();
    await commands.finalize(actor, siteId, id);
    const original = images.dominantColors;
    images.dominantColors = async (image, count) => {
      await assets.delete(id);
      return original(image, count);
    };
    try {
      expect(await commands.process(id)).toBe('skipped');
    } finally {
      images.dominantColors = original;
    }
    expect(publicFiles.files.size).toBe(0);
  });

  it('refuses to delete an image being processed, and marks it failed when its job gives up', async () => {
    const id = await uploaded();
    await commands.finalize(actor, siteId, id);
    await expect(commands.remove(actor, siteId, id)).rejects.toMatchObject({
      details: { reason: 'ASSET_PROCESSING' },
    });
    await commands.fail(id);
    expect(assets.rows.get(id)?.status).toBe('failed');
    await expect(commands.finalize(actor, siteId, id)).rejects.toMatchObject({
      details: { reason: 'ASSET_FAILED' },
    });
    await commands.remove(actor, siteId, id);
    expect(assets.rows.has(id)).toBe(false);
  });

  it('refuses an image too large to decode safely, and deletes its original', async () => {
    const id = await uploaded();
    const original = images.inspect;
    images.inspect = async () => ({ width: 10_000, height: 5_000 });
    try {
      await expect(commands.finalize(actor, siteId, id)).rejects.toMatchObject({
        details: { reason: 'ASSET_TOO_LARGE' },
      });
    } finally {
      images.inspect = original;
    }
    expect(await originals.get(assets.rows.get(id)?.storageKey ?? '')).toBeUndefined();
  });

  it('fails an image whose job died, after a while, and removes the variants it had written', async () => {
    const id = await uploaded();
    await commands.finalize(actor, siteId, id);
    // A job that started, wrote one variant, then died (no `fail`): the image is still processing.
    const row = assets.rows.get(id);
    if (row) assets.rows.set(id, { ...row, processingStartedAt: new Date('2026-10-14T12:00:00.000Z') });
    await publicFiles.put(`sites/${siteId}/${id}/480.webp`, Buffer.from('x'), 'image/webp');
    expect(await commands.failStale()).toBe(0);
    await expect(commands.remove(actor, siteId, id)).rejects.toMatchObject({
      details: { reason: 'ASSET_PROCESSING' },
    });
    const later = new SiteAssetCommands(
      sites,
      assets,
      { presignPut: async () => ({ url: 'https://uploads.test/x', headers: {} }) },
      originals,
      publicFiles,
      images,
      { process: async () => undefined },
      fixedClock('2026-10-14T13:00:00.000Z'),
      fakeDb,
    );
    expect(await later.failStale()).toBe(1);
    expect(assets.rows.get(id)?.status).toBe('failed');
    expect(publicFiles.files.size).toBe(0);
  });

  it('removes the variants a failed last attempt had written', async () => {
    const id = await uploaded();
    await commands.finalize(actor, siteId, id);
    await publicFiles.put(`sites/${siteId}/${id}/768.avif`, Buffer.from('x'), 'image/avif');
    await commands.fail(id);
    expect(assets.rows.get(id)?.status).toBe('failed');
    expect(publicFiles.files.size).toBe(0);
  });

  it('never fails an image waiting in the queue, but one whose job never started for a day', async () => {
    const id = await uploaded();
    await commands.finalize(actor, siteId, id);
    const at = (iso: string) =>
      new SiteAssetCommands(
        sites,
        assets,
        { presignPut: async () => ({ url: 'https://uploads.test/x', headers: {} }) },
        originals,
        publicFiles,
        images,
        { process: async () => undefined },
        fixedClock(iso),
        fakeDb,
      );
    expect(await at('2026-10-14T18:00:00.000Z').failStale()).toBe(0);
    await expect(at('2026-10-14T18:00:00.000Z').remove(actor, siteId, id)).rejects.toMatchObject({
      details: { reason: 'ASSET_PROCESSING' },
    });
    // A day later its job is presumed lost: failed by the sweep, then deletable.
    expect(await at('2026-10-15T13:00:00.000Z').failStale()).toBe(1);
    await at('2026-10-15T13:00:00.000Z').remove(actor, siteId, id);
    expect(assets.rows.has(id)).toBe(false);
  });

  it('stamps the processing start when the job starts', async () => {
    const id = await uploaded();
    await commands.finalize(actor, siteId, id);
    expect(assets.rows.get(id)?.processingStartedAt).toBeNull();
    const original = images.dominantColors;
    let started: Date | null | undefined;
    images.dominantColors = async (image, count) => {
      started = assets.rows.get(id)?.processingStartedAt;
      return original(image, count);
    };
    try {
      await commands.process(id);
    } finally {
      images.dominantColors = original;
    }
    expect(started).toEqual(new Date('2026-10-14T12:00:00.000Z'));
  });

  it('lets only the delivery that stamped the job finish it, and never deletes the winner’s files', async () => {
    const id = await uploaded();
    await commands.finalize(actor, siteId, id);
    const later = new SiteAssetCommands(
      sites,
      assets,
      { presignPut: async () => ({ url: 'https://uploads.test/x', headers: {} }) },
      originals,
      publicFiles,
      images,
      { process: async () => undefined },
      fixedClock('2026-10-14T12:05:00.000Z'),
      fakeDb,
    );
    const original = images.dominantColors;
    let second: string | undefined;
    images.dominantColors = async (image, count) => {
      // A stalled job delivered again while the first one still runs: it re-stamps and finishes first.
      if (second === undefined) {
        second = 'running';
        second = await later.process(id);
      }
      return original(image, count);
    };
    try {
      expect(await commands.process(id)).toBe('skipped');
    } finally {
      images.dominantColors = original;
    }
    expect(second).toBe('ready');
    expect(assets.rows.get(id)?.status).toBe('ready');
    expect(publicFiles.files.size).toBeGreaterThan(0);
  });

  it('keeps the files when a re-delivered job holds the stamp and the first one finishes first', async () => {
    const id = await uploaded();
    await commands.finalize(actor, siteId, id);
    const original = images.dominantColors;
    let written: string[] = [];
    images.dominantColors = async (image, count) => {
      // The retry re-stamps the image while the first delivery is about to finish (every variant is written by now).
      written = [...publicFiles.files.keys()];
      const row = assets.rows.get(id);
      if (row) assets.rows.set(id, { ...row, processingStartedAt: new Date('2026-10-14T12:05:00.000Z') });
      return original(image, count);
    };
    try {
      // The first delivery is fenced out: it finishes nothing and deletes nothing.
      expect(await commands.process(id)).toBe('skipped');
    } finally {
      images.dominantColors = original;
    }
    expect(assets.rows.get(id)?.status).toBe('processing');
    expect(written.length).toBeGreaterThan(0);
    expect([...publicFiles.files.keys()].sort()).toEqual([...written].sort());
  });

  it('removes what a fenced-out delivery wrote once the image has failed, even if one delete fails', async () => {
    const id = await uploaded();
    await commands.finalize(actor, siteId, id);
    const original = images.dominantColors;
    const remove = publicFiles.delete.bind(publicFiles);
    let calls = 0;
    publicFiles.delete = async (key) => {
      calls += 1;
      if (calls === 1) throw new Error('storage unavailable');
      return remove(key);
    };
    images.dominantColors = async (image, count) => {
      // The image failed meanwhile (the stale sweep, or the retry's last attempt) after a re-stamp.
      const row = assets.rows.get(id);
      if (row) assets.rows.set(id, { ...row, status: 'failed', processingStartedAt: null });
      return original(image, count);
    };
    try {
      expect(await commands.process(id)).toBe('skipped');
    } finally {
      images.dominantColors = original;
      publicFiles.delete = remove;
    }
    expect(calls).toBeGreaterThan(1);
    expect(publicFiles.files.size).toBe(1);
  });
});
