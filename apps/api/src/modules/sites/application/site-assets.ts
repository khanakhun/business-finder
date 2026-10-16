import { createHash } from 'node:crypto';
import {
  type Clock,
  ConflictError,
  type CreateSiteAssetUploadRequest,
  NotFoundError,
  newId,
  type SiteAsset,
  type SiteAssetUpload,
  type SiteId,
  ValidationError,
} from '@bf/contracts';
import { afterCommit, type DbClient } from '@bf/db';
import type { Logger } from '@bf/observability';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { LOGGER } from '../../platform/logging/logger.ts';
import type { ObjectStorage } from '../../platform/storage/object-storage.ts';
import { MAX_IMAGE_PIXELS, sniffImageType } from '../domain/image-type.ts';
import {
  ASSET_PROCESSING_QUEUE,
  type AssetProcessingQueue,
  IMAGE_PROCESSOR,
  type ImageProcessor,
  PUBLIC_FILES,
  type PublicFiles,
  SITE_ASSETS_REPOSITORY,
  SITE_ORIGINALS,
  SITES_REPOSITORY,
  type SiteAssetsRepository,
  type SitesRepository,
  type StoredAsset,
  UPLOAD_SIGNER,
  type UploadSigner,
} from './ports.ts';
import type { SiteActor } from './sites.commands.ts';

/** Widths of the public variants (never enlarged: an image between two steps also gets its own width). */
export const VARIANT_WIDTHS = [480, 768, 1200, 1920] as const;
/** How long a presigned upload URL is valid. */
const UPLOAD_SECONDS = 15 * 60;
/** Processing takes seconds: an image processing for longer than this has lost its job. */
export const STALE_PROCESSING_MS = 30 * 60_000;
/** A finalized image whose job never started (a lost queue) is failed after a day. */
export const NEVER_STARTED_MS = 86_400_000;

/** The one rule of staleness: the hourly sweep and a delete apply the same cutoffs. */
export const staleCutoffs = (now: Date) => ({
  startedBefore: new Date(now.getTime() - STALE_PROCESSING_MS),
  createdBefore: new Date(now.getTime() - NEVER_STARTED_MS),
});

/** The widths an image of `width` pixels is published at: the steps it reaches, and its own below the largest. */
export function variantWidths(width: number): number[] {
  const steps: number[] = VARIANT_WIDTHS.filter((step) => step <= width);
  const largest = VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1] ?? 1920;
  if (width > 0 && width < largest && !steps.includes(width)) steps.push(width);
  return steps;
}

const toAsset = (asset: StoredAsset): SiteAsset => ({
  id: asset.id,
  siteId: asset.siteId as SiteId | null,
  status: asset.status,
  mime: asset.mime,
  width: asset.width,
  height: asset.height,
  bytes: asset.bytes,
  publicUrl: asset.publicUrl,
  variants: (asset.variants ?? []).map((variant) => ({
    width: variant.width,
    format: variant.format as 'webp' | 'avif',
    url: variant.url,
  })),
  license: asset.license,
  licenseDetails: asset.licenseDetails,
  alt: asset.alt,
  dominantColors: asset.dominantColors,
  createdAt: asset.createdAt.toISOString(),
});

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/**
 * Site images (BF-035): the browser uploads the original straight to the private bucket with a presigned URL (the
 * license is declared up front), then finalizes; the API checks the bytes (type sniffed, size, dimensions) and a job
 * strips and re-encodes it into public WebP/AVIF variants behind the CDN. The original stays private.
 */
@Injectable()
export class SiteAssetCommands {
  constructor(
    @Inject(SITES_REPOSITORY) private readonly sites: SitesRepository,
    @Inject(SITE_ASSETS_REPOSITORY) private readonly assets: SiteAssetsRepository,
    @Inject(UPLOAD_SIGNER) private readonly signer: UploadSigner,
    @Inject(SITE_ORIGINALS) private readonly originals: ObjectStorage,
    @Inject(PUBLIC_FILES) private readonly publicFiles: PublicFiles,
    @Inject(IMAGE_PROCESSOR) private readonly images: ImageProcessor,
    @Inject(ASSET_PROCESSING_QUEUE) private readonly queue: AssetProcessingQueue,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Optional() @Inject(LOGGER) private readonly logger?: Logger,
  ) {}

  /** Best effort: a file left behind is logged (to be found and removed), never a reason to fail the caller. */
  private async discard(storage: Pick<PublicFiles, 'delete'>, assetId: string, key: string): Promise<void> {
    try {
      await storage.delete(key);
    } catch (error) {
      this.logger?.warn(
        { assetId, key, err: error instanceof Error ? error.message : String(error) },
        'site image file not deleted',
      );
    }
  }

  /** A pending asset and a presigned URL to upload its original to (exactly the declared type and size). */
  @Transactional()
  async createUpload(
    actor: SiteActor,
    siteId: string,
    input: CreateSiteAssetUploadRequest,
  ): Promise<SiteAssetUpload> {
    const site = await this.site(actor, siteId);
    const id = newId();
    const asset = await this.assets.insert({
      id,
      organizationId: actor.organizationId,
      siteId: site,
      storageKey: `orgs/${actor.organizationId}/sites/${site}/assets/${id}/original`,
      mime: input.mime,
      bytes: input.bytes,
      license: input.license,
      licenseDetails: input.licenseDetails
        ? Object.fromEntries(
            Object.entries(input.licenseDetails).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          )
        : null,
      alt: input.alt ?? null,
      createdBy: actor.userId,
    });
    const { url, headers } = await this.signer.presignPut(
      asset.storageKey,
      input.mime,
      input.bytes,
      UPLOAD_SECONDS,
    );
    return {
      asset: toAsset(asset),
      uploadUrl: url,
      method: 'PUT',
      headers,
      expiresAt: new Date(this.clock.now().getTime() + UPLOAD_SECONDS * 1000).toISOString(),
    };
  }

  /**
   * Checks the uploaded original and queues its processing. Refused (marked failed, the object deleted): a size or
   * type that differs from the declaration, an image that cannot be decoded or is too large. Not a transaction: a
   * refusal must stick. Every status change is a compare-and-set, so two finalizes and the job never undo each other.
   */
  async finalize(actor: SiteActor, siteId: string, assetId: string): Promise<SiteAsset> {
    const asset = await this.asset(actor, siteId, assetId);
    if (asset.status === 'ready') return toAsset(asset);
    if (asset.status === 'failed')
      throw new ConflictError('The image was refused: upload it again.', {
        details: { reason: 'ASSET_FAILED' },
      });
    // Already checked: queue it again (a no-op while its job runs or has run).
    if (asset.status === 'processing') {
      await this.queue.process(asset.id, actor.organizationId);
      return toAsset(asset);
    }
    const object = await this.originals.get(asset.storageKey);
    if (!object)
      throw new ConflictError('The image has not been uploaded yet.', {
        details: { reason: 'ASSET_NOT_UPLOADED' },
      });
    const refuse = async (message: string, reason: string) => {
      if (await this.assets.transition(asset.id, ['pending'], { status: 'failed' })) {
        // Best effort: a failed asset is never processed or served, whether or not its original is gone.
        await this.discard(this.originals, asset.id, asset.storageKey);
      }
      return new ValidationError(message, [{ path: ['file'], message, code: reason.toLowerCase() }], {
        details: { reason },
      });
    };
    if (object.body.length !== asset.bytes)
      throw await refuse('The upload is not the declared size.', 'ASSET_SIZE_MISMATCH');
    const type = sniffImageType(object.body);
    if (!type || type !== asset.mime)
      throw await refuse('The file is not the declared image type.', 'ASSET_TYPE_MISMATCH');
    let size: { width: number; height: number };
    try {
      size = await this.images.inspect(object.body);
    } catch {
      throw await refuse('The image cannot be read.', 'ASSET_UNREADABLE');
    }
    if (size.width * size.height > MAX_IMAGE_PIXELS)
      throw await refuse('The image is too large.', 'ASSET_TOO_LARGE');
    const checked = {
      status: 'processing' as const,
      width: size.width,
      height: size.height,
      sha256: sha256(object.body),
    };
    if (!(await this.assets.transition(asset.id, ['pending'], checked))) {
      // Another finalize got there first: answer with what it did.
      return toAsset(await this.asset(actor, siteId, assetId));
    }
    await this.queue.process(asset.id, actor.organizationId);
    return toAsset({ ...asset, ...checked });
  }

  async list(actor: SiteActor, siteId: string): Promise<SiteAsset[]> {
    const site = await this.site(actor, siteId);
    return (await this.assets.list(actor.organizationId, site)).map(toAsset);
  }

  /**
   * Deletes an asset no version of the site names (its original and variants go with it). The site row is locked
   * first: a version naming the image cannot commit between the check and the delete. An image being processed is
   * deleted once it is ready or failed (the job would publish its variants after the delete).
   */
  @Transactional()
  async remove(actor: SiteActor, siteId: string, assetId: string): Promise<void> {
    const site = await this.sites.lockSite(actor.organizationId, siteId);
    if (!site) throw new NotFoundError('Site', siteId);
    // The row locked and read now: a finalize or a job finishing meanwhile waits, then finds it gone.
    const asset = await this.assets.lock(actor.organizationId, site.id, assetId);
    if (!asset) throw new NotFoundError('SiteAsset', assetId);
    if (asset.status === 'processing' && !this.stale(asset))
      throw new ConflictError('The image is being processed: delete it in a moment.', {
        details: { reason: 'ASSET_PROCESSING' },
      });
    const needles = [
      asset.id,
      ...(asset.publicUrl ? [asset.publicUrl] : []),
      ...(asset.variants ?? []).map((v) => v.url),
    ];
    if (await this.assets.referenced(site.id, needles)) {
      throw new ConflictError('A version of the site uses this image.', {
        details: { reason: 'ASSET_IN_USE' },
      });
    }
    await this.assets.delete(asset.id);
    await afterCommit(this.db, async () => {
      await this.originals.delete(asset.storageKey);
      for (const key of this.variantKeys(asset)) await this.publicFiles.delete(key);
    });
  }

  /**
   * The processing job: public variants (WebP and AVIF per width) and dominant colours, from the bytes finalize
   * checked (re-hashed: an upload replaced since is refused). Idempotent; the variants it wrote are removed when the
   * asset changed meanwhile (deleted).
   */
  async process(assetId: string): Promise<'ready' | 'failed' | 'skipped'> {
    const asset = await this.assets.byId(assetId);
    if (asset?.status !== 'processing') return 'skipped';
    // The job's start, not the finalize's: time waiting in the queue never makes an image stale.
    const startedAt = this.clock.now();
    if (!(await this.assets.transition(asset.id, ['processing'], { processingStartedAt: startedAt })))
      return 'skipped';
    const object = await this.originals.get(asset.storageKey);
    if (
      !object ||
      !asset.sha256 ||
      sha256(object.body) !== asset.sha256 ||
      sniffImageType(object.body) !== asset.mime
    ) {
      await this.fail(asset.id);
      return 'failed';
    }
    const encoded = await this.images.variants(object.body, variantWidths(asset.width ?? 0));
    const base = `sites/${asset.siteId ?? 'library'}/${asset.id}`;
    const variants = [];
    for (const variant of encoded) {
      const key = `${base}/${variant.width}.${variant.format}`;
      await this.publicFiles.put(key, variant.body, `image/${variant.format}`);
      variants.push({
        width: variant.width,
        format: variant.format,
        key,
        url: this.publicFiles.url(key),
        bytes: variant.body.length,
      });
    }
    // The default: 1200 px WebP, or the largest WebP when the image is smaller.
    const webp = variants.filter((variant) => variant.format === 'webp');
    const preferred = webp.find((variant) => variant.width === 1200) ?? webp.at(-1);
    // Fenced by this job's own start: a second delivery of the job (a stalled one retried) cannot finish it too.
    const done = await this.assets.transition(
      asset.id,
      ['processing'],
      {
        status: 'ready',
        processingStartedAt: null,
        variants,
        publicUrl: preferred?.url ?? null,
        dominantColors: await this.images.dominantColors(object.body, 3),
      },
      startedAt,
    );
    if (!done) {
      // Another delivery holds the stamp (the same keys: its files stay, whether it has finished or not; the sweep
      // cleans up if it dies). Only a deleted or failed image loses the files this one wrote.
      const current = await this.assets.byId(asset.id);
      if (!current || current.status === 'failed')
        // Best effort, like fail(): a retry would find the image settled and skip, so one error must not stop the rest.
        for (const variant of variants) await this.discard(this.publicFiles, asset.id, variant.key);
      return 'skipped';
    }
    return 'ready';
  }

  /**
   * The job gave up (its last attempt failed): the asset is failed, not left processing, and any variant it had
   * already written is removed (their keys are known from the widths).
   */
  async fail(assetId: string): Promise<void> {
    const asset = await this.assets.byId(assetId);
    if (!asset || !(await this.assets.transition(assetId, ['processing'], { status: 'failed' }))) return;
    for (const key of this.variantKeys(asset)) await this.discard(this.publicFiles, assetId, key);
  }

  /**
   * Images whose job died (a killed worker never reaches `fail`): failed `STALE_PROCESSING_MS` after their job started,
   * or a day after their upload when no job ever started (a lost queue). Hourly.
   */
  async failStale(limit = 500): Promise<number> {
    const stale = await this.assets.failStale(staleCutoffs(this.clock.now()), limit);
    for (const asset of stale)
      for (const key of this.variantKeys(asset)) await this.discard(this.publicFiles, asset.id, key);
    return stale.length;
  }

  /** Processing for too long: 30 minutes after its job started, or a day after the upload if no job ever started. */
  private stale(asset: StoredAsset): boolean {
    const { startedBefore, createdBefore } = staleCutoffs(this.clock.now());
    return asset.processingStartedAt
      ? asset.processingStartedAt < startedBefore
      : asset.createdAt < createdBefore;
  }

  /** Every public key an asset may have: those it lists, and those its widths give (a job that stopped midway). */
  private variantKeys(asset: StoredAsset): string[] {
    const base = `sites/${asset.siteId ?? 'library'}/${asset.id}`;
    const derived = variantWidths(asset.width ?? 0).flatMap((width) => [
      `${base}/${width}.webp`,
      `${base}/${width}.avif`,
    ]);
    return [...new Set([...(asset.variants ?? []).map((variant) => variant.key), ...derived])];
  }

  private async site(actor: SiteActor, siteId: string): Promise<string> {
    const site = await this.sites.site(actor.organizationId, siteId);
    if (!site) throw new NotFoundError('Site', siteId);
    return site.id;
  }

  private async asset(actor: SiteActor, siteId: string, assetId: string): Promise<StoredAsset> {
    const asset = await this.assets.get(actor.organizationId, siteId, assetId);
    if (!asset) throw new NotFoundError('SiteAsset', assetId);
    return asset;
  }
}
