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
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import type { ObjectStorage } from '../../platform/storage/object-storage.ts';
import { sniffImageType } from '../domain/image-type.ts';
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

/** Widths of the public variants (never enlarged: a smaller image keeps its own width). */
export const VARIANT_WIDTHS = [480, 768, 1200, 1920] as const;
/** How long a presigned upload URL is valid. */
const UPLOAD_SECONDS = 15 * 60;
/** Images larger than this many pixels are refused (decompression bombs). */
export const MAX_PIXELS = 40_000_000;

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
  ) {}

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
   * refusal must stick. Calling it again while processing re-queues the same job (idempotent per asset).
   */
  async finalize(actor: SiteActor, siteId: string, assetId: string): Promise<SiteAsset> {
    const asset = await this.asset(actor, siteId, assetId);
    if (asset.status === 'ready') return toAsset(asset);
    const object = asset.status === 'failed' ? undefined : await this.originals.get(asset.storageKey);
    if (!object)
      throw new ConflictError('The image has not been uploaded yet.', {
        details: { reason: 'ASSET_NOT_UPLOADED' },
      });
    const refuse = async (message: string, reason: string) => {
      await this.assets.update(asset.id, { status: 'failed' });
      // Best effort: a failed asset is never processed or served, whether or not its original is gone.
      await this.originals.delete(asset.storageKey).catch(() => undefined);
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
    if (size.width * size.height > MAX_PIXELS)
      throw await refuse('The image is too large.', 'ASSET_TOO_LARGE');
    await this.assets.update(asset.id, {
      status: 'processing',
      width: size.width,
      height: size.height,
      sha256: createHash('sha256').update(object.body).digest('hex'),
    });
    await this.queue.process(asset.id, actor.organizationId);
    return toAsset({ ...asset, status: 'processing', width: size.width, height: size.height });
  }

  async list(actor: SiteActor, siteId: string): Promise<SiteAsset[]> {
    const site = await this.site(actor, siteId);
    return (await this.assets.list(actor.organizationId, site)).map(toAsset);
  }

  /** Deletes an asset no version of the site names (its original and variants go with it). */
  @Transactional()
  async remove(actor: SiteActor, siteId: string, assetId: string): Promise<void> {
    const asset = await this.asset(actor, siteId, assetId);
    const needles = [
      asset.id,
      ...(asset.publicUrl ? [asset.publicUrl] : []),
      ...(asset.variants ?? []).map((v) => v.url),
    ];
    if (asset.siteId && (await this.assets.referenced(asset.siteId, needles))) {
      throw new ConflictError('A version of the site uses this image.', {
        details: { reason: 'ASSET_IN_USE' },
      });
    }
    await this.assets.delete(asset.id);
    await afterCommit(this.db, async () => {
      await this.originals.delete(asset.storageKey);
      for (const variant of asset.variants ?? []) await this.publicFiles.delete(variant.key);
    });
  }

  /** The processing job: public variants (WebP and AVIF per width) and dominant colours; idempotent. */
  async process(assetId: string): Promise<'ready' | 'failed' | 'skipped'> {
    const asset = await this.assets.byId(assetId);
    if (!asset || asset.status === 'ready') return 'skipped';
    if (asset.status !== 'processing') return 'skipped';
    const object = await this.originals.get(asset.storageKey);
    if (!object) {
      await this.assets.update(asset.id, { status: 'failed' });
      return 'failed';
    }
    const widths = VARIANT_WIDTHS.filter((width) => width <= (asset.width ?? 0));
    const encoded = await this.images.variants(
      object.body,
      widths.length > 0 ? widths : [asset.width ?? 480],
    );
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
    await this.assets.update(asset.id, {
      status: 'ready',
      variants,
      publicUrl: preferred?.url ?? null,
      dominantColors: await this.images.dominantColors(object.body, 3),
    });
    return 'ready';
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
