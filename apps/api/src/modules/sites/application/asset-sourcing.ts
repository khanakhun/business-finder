import { createHash } from 'node:crypto';
import {
  type Clock,
  type ConfirmAssetOwnershipRequest,
  ConflictError,
  NotFoundError,
  newId,
  type SiteAsset,
  SiteAssetAnalyzed,
  type SiteAssetCandidate,
  type SiteAssetCollectResult,
  SiteAssetOwnershipConfirmed,
  type SiteAssetSuggestions,
  type SiteAssetSuggestionsQuery,
} from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { EventRecorder } from '../../platform/events/event-recorder.ts';
import { LOGGER } from '../../platform/logging/logger.ts';
import type { ObjectStorage } from '../../platform/storage/object-storage.ts';
import { isNearDuplicate } from '../domain/assets/dhash.ts';
import { isProviderPhoto, judgeOwnerImage } from '../domain/assets/image-policy.ts';
import { type RankableAsset, rankCandidates } from '../domain/assets/ranking.ts';
import { MAX_IMAGE_PIXELS, sniffImageType } from '../domain/image-type.ts';
import {
  ASSET_PROCESSING_QUEUE,
  ASSET_SOURCING_QUEUE,
  type AssetProcessingQueue,
  type AssetSourcingQueue,
  IMAGE_PROCESSOR,
  type ImageProcessor,
  SITE_ASSETS_REPOSITORY,
  SITE_ORIGINALS,
  SITES_REPOSITORY,
  type SiteAssetsRepository,
  type SitesRepository,
  type StoredAsset,
} from './ports.ts';
import { toAsset } from './site-assets.ts';
import type { SiteActor } from './sites.commands.ts';

// Image sourcing (BF-038, part 1): a business's own website images and logos (downloaded by services/intel through
// its SSRF guard, filtered, deduplicated, processed like uploads, `preview_only` until ownership is confirmed), a
// generated wordmark when no logo exists, vision analysis (tags, alt texts, focal point) and an explainable ranking
// per role. Stock and AI images come in part 2 through the same library.

/** What the business's website offered (BF-026 site intel's latest snapshot). */
export interface OwnerSiteImages {
  readonly images: readonly { readonly url: string; readonly alt: string | null }[];
  readonly logos: readonly { readonly url: string }[];
}

export interface OwnerSiteImagesReader {
  latest(organizationId: string, businessId: string): Promise<OwnerSiteImages | undefined>;
}
export const OWNER_SITE_IMAGES = Symbol('OwnerSiteImages');

/** Downloads one crawled image (services/intel's SSRF-guarded fetch). Throws when it cannot. */
export interface ImageFetcher {
  fetch(url: string, signal?: AbortSignal): Promise<Uint8Array>;
}
export const IMAGE_FETCHER = Symbol('ImageFetcher');

/** The site's identity for a wordmark: its name, a face and a colour. */
export interface WordmarkMaker {
  make(input: {
    readonly name: string;
    readonly face: 'serif' | 'sans';
    readonly color: string;
  }): Promise<{ readonly logo: Buffer; readonly favicon: Buffer; readonly key: string }>;
}
export const WORDMARK_MAKER = Symbol('WordmarkMaker');

export interface ImageAnalysis {
  readonly depicts: NonNullable<SiteAsset['analysis']>['depicts'];
  readonly containsText: boolean;
  readonly containsPeople: boolean;
  readonly identifiablePeople: boolean;
  readonly quality: number;
  readonly heroSuitability: number;
  readonly mood: readonly string[];
  readonly alt: Readonly<Record<string, string>>;
}

/** The vision model behind analysis (the AI gateway; a deterministic fake in tests and E2E). */
export interface ImageAnalyzer {
  analyze(input: {
    readonly organizationId: string;
    readonly image: Buffer;
    readonly businessName: string;
    readonly locales: readonly string[];
    readonly source: 'owner_site' | 'stock' | 'ai' | 'upload';
  }): Promise<ImageAnalysis>;
}
export const IMAGE_ANALYZER = Symbol('ImageAnalyzer');

/** At most this many photos and logos are taken from one website per collection. */
const MAX_OWNER_PHOTOS = 20;
const MAX_OWNER_LOGOS = 5;
const MAX_FETCH_BYTES = 15 * 1024 * 1024;

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** What the current version says about the site: its languages, palette, name and font style. */
interface SiteLook {
  readonly locales: readonly string[];
  readonly palette: readonly string[];
  readonly name: string;
  readonly face: 'serif' | 'sans';
  readonly color: string;
}

const SERIF_PAIRS = /cormorant|playfair|fraunces|serif/i;

function lookOf(spec: Record<string, unknown> | undefined, fallbackName: string): SiteLook {
  const theme = (spec?.theme ?? {}) as {
    palette?: Record<string, string>;
    typography?: { pairId?: string };
  };
  const palette = Object.values(theme.palette ?? {}).filter((value) => /^#[0-9a-f]{6}$/i.test(value));
  const brand = (spec?.brand ?? {}) as { name?: string };
  const locales = Array.isArray(spec?.locales) ? (spec.locales as string[]) : ['fr'];
  return {
    locales,
    palette,
    name: brand.name ?? fallbackName,
    face: SERIF_PAIRS.test(theme.typography?.pairId ?? '') ? 'serif' : 'sans',
    color: theme.palette?.primary ?? '#1f2937',
  };
}

@Injectable()
export class AssetSourcing {
  constructor(
    @Inject(SITES_REPOSITORY) private readonly sites: SitesRepository,
    @Inject(SITE_ASSETS_REPOSITORY) private readonly assets: SiteAssetsRepository,
    @Inject(SITE_ORIGINALS) private readonly originals: ObjectStorage,
    @Inject(IMAGE_PROCESSOR) private readonly images: ImageProcessor,
    @Inject(ASSET_PROCESSING_QUEUE) private readonly processing: AssetProcessingQueue,
    @Inject(ASSET_SOURCING_QUEUE) private readonly queue: AssetSourcingQueue,
    @Inject(OWNER_SITE_IMAGES) private readonly ownerSite: OwnerSiteImagesReader,
    @Inject(IMAGE_FETCHER) private readonly fetcher: ImageFetcher,
    @Inject(WORDMARK_MAKER) private readonly wordmarks: WordmarkMaker,
    @Inject(IMAGE_ANALYZER) private readonly analyzer: ImageAnalyzer,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly events: EventRecorder,
    @Optional() @Inject(LOGGER) private readonly logger?: Logger,
  ) {}

  /** Queues a collection of the site's images (the refresh button, a generation). */
  async refresh(actor: SiteActor, siteId: string): Promise<void> {
    const site = await this.sites.site(actor.organizationId, siteId);
    if (!site) throw new NotFoundError('Site', siteId);
    await this.queue.collect(actor.organizationId, site.id);
  }

  /**
   * The collection job: the website's photos and logos not already in the library, then a wordmark when the site
   * still has no logo. Idempotent (a source URL is taken once per site; near-duplicates are skipped).
   */
  async collect(
    organizationId: string,
    siteId: string,
    signal?: AbortSignal,
  ): Promise<SiteAssetCollectResult> {
    const result = { added: { upload: 0, owner_site: 0, stock: 0, ai: 0, wordmark: 0 }, rejected: 0 };
    const site = await this.sites.site(organizationId, siteId);
    if (!site) return result;
    const version = site.currentVersionId
      ? await this.sites.version(site.id, site.currentVersionId)
      : undefined;
    const look = lookOf(version?.spec, site.businessName);
    const library = await this.assets.list(organizationId, site.id);
    const known = {
      urls: new Set(library.flatMap((asset) => (asset.sourceUrl ? [asset.sourceUrl] : []))),
      hashes: new Set(library.flatMap((asset) => (asset.sha256 ? [asset.sha256] : []))),
      dhashes: library.flatMap((asset) => (asset.dhash ? [asset.dhash] : [])),
    };
    let hasLogo = library.some((asset) => asset.kind === 'logo' && asset.status !== 'failed');

    const owner = await this.ownerSite.latest(organizationId, site.businessId);
    const candidates = [
      ...(owner?.images ?? [])
        .slice(0, MAX_OWNER_PHOTOS)
        .map((image) => ({ url: image.url, kind: 'photo' as const })),
      ...(owner?.logos ?? [])
        .slice(0, MAX_OWNER_LOGOS)
        .map((logo) => ({ url: logo.url, kind: 'logo' as const })),
    ];
    for (const candidate of candidates) {
      if (signal?.aborted) break;
      // A logo already found makes the next ones redundant.
      if (candidate.kind === 'logo' && hasLogo) continue;
      if (known.urls.has(candidate.url)) continue;
      if (isProviderPhoto(candidate.url)) {
        result.rejected++;
        this.logger?.info({ siteId, reason: 'provider_photo' }, 'owner-site image rejected');
        continue;
      }
      const kept = await this.takeOwnerImage(organizationId, site.id, candidate, known, signal);
      if (kept) {
        result.added.owner_site++;
        if (candidate.kind === 'logo') hasLogo = true;
      } else result.rejected++;
    }

    if (!hasLogo) {
      if (await this.addWordmark(organizationId, site.id, look, known.urls)) result.added.wordmark += 2;
    }
    return result;
  }

  /** Downloads, measures, judges and stores one website image; false when it is not kept. */
  private async takeOwnerImage(
    organizationId: string,
    siteId: string,
    candidate: { readonly url: string; readonly kind: 'photo' | 'logo' },
    known: { urls: Set<string>; hashes: Set<string>; dhashes: string[] },
    signal?: AbortSignal,
  ): Promise<boolean> {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await this.fetcher.fetch(candidate.url, signal));
    } catch (error) {
      this.logger?.info(
        { siteId, err: error instanceof Error ? error.message : String(error) },
        'owner-site image not downloaded',
      );
      return false;
    }
    // Bytes are untrusted: the type is sniffed, the image decoded within limits.
    const mime = sniffImageType(bytes);
    if (!mime || bytes.length > MAX_FETCH_BYTES) return false;
    let size: { width: number; height: number };
    let measured: Awaited<ReturnType<ImageProcessor['measure']>>;
    try {
      size = await this.images.inspect(bytes);
      if (size.width * size.height > MAX_IMAGE_PIXELS) return false;
      measured = await this.images.measure(bytes);
    } catch {
      return false;
    }
    const verdict = judgeOwnerImage(
      { url: candidate.url, width: size.width, height: size.height, sharpness: measured.sharpness },
      candidate.kind,
    );
    if (!verdict.ok) {
      this.logger?.info({ siteId, reason: verdict.reason }, 'owner-site image rejected');
      return false;
    }
    const hash = sha256(bytes);
    if (known.hashes.has(hash) || isNearDuplicate(measured.dhash, known.dhashes)) return false;
    const id = newId();
    const storageKey = `orgs/${organizationId}/sites/${siteId}/assets/${id}/original`;
    await this.originals.put(storageKey, bytes, mime);
    try {
      await this.assets.insert({
        id,
        organizationId,
        siteId,
        storageKey,
        mime,
        bytes: bytes.length,
        license: 'owner_site',
        licenseDetails: { sourceUrl: candidate.url.slice(0, 500) },
        alt: null,
        kind: candidate.kind === 'logo' ? 'logo' : 'image',
        source: 'owner_site',
        sourceUrl: candidate.url,
        dhash: measured.dhash,
        // Usable in a private preview of this business; never live until it confirms ownership (ADR-0013).
        restrictions: ['preview_only'],
        focalPoint: measured.focalPoint,
        createdBy: null,
      });
    } catch (error) {
      // Another collection took the same URL first (unique per site): ours is redundant.
      await this.originals.delete(storageKey);
      if (error instanceof Error && /uq_site_assets__site_id_source_url/.test(error.message)) return false;
      throw error;
    }
    await this.assets.transition(id, ['pending'], {
      status: 'processing',
      width: size.width,
      height: size.height,
      sha256: hash,
    });
    await this.processing.process(id, organizationId);
    known.urls.add(candidate.url);
    known.hashes.add(hash);
    known.dhashes.push(measured.dhash);
    return true;
  }

  /** The wordmark and its favicon monogram, as PNG logos (`system_generated`); false when already there. */
  private async addWordmark(
    organizationId: string,
    siteId: string,
    look: SiteLook,
    knownUrls: Set<string>,
  ): Promise<boolean> {
    const made = await this.wordmarks.make({ name: look.name, face: look.face, color: look.color });
    const sources = [
      { url: `wordmark:${made.key}`, body: made.logo },
      { url: `monogram:${made.key}`, body: made.favicon },
    ];
    if (sources.every((source) => knownUrls.has(source.url))) return false;
    for (const source of sources) {
      if (knownUrls.has(source.url)) continue;
      const size = await this.images.inspect(source.body);
      const id = newId();
      const storageKey = `orgs/${organizationId}/sites/${siteId}/assets/${id}/original`;
      await this.originals.put(storageKey, source.body, 'image/png');
      await this.assets.insert({
        id,
        organizationId,
        siteId,
        storageKey,
        mime: 'image/png',
        bytes: source.body.length,
        license: 'system_generated',
        licenseDetails: { provider: 'Business Finder wordmark' },
        alt: Object.fromEntries(look.locales.map((locale) => [locale, look.name.slice(0, 150)])),
        kind: 'logo',
        source: 'wordmark',
        sourceUrl: source.url,
        createdBy: null,
      });
      await this.assets.transition(id, ['pending'], {
        status: 'processing',
        width: size.width,
        height: size.height,
        sha256: sha256(source.body),
      });
      await this.processing.process(id, organizationId);
      knownUrls.add(source.url);
    }
    return true;
  }

  /**
   * The analysis job (after processing): tags, alt texts in the site's languages (only where none was written),
   * and the saliency focal point when none was set. Wordmarks need none. Idempotent.
   */
  async analyze(assetId: string): Promise<'analyzed' | 'skipped'> {
    const asset = await this.assets.byId(assetId);
    if (asset?.status !== 'ready' || !asset.siteId || asset.source === 'wordmark') return 'skipped';
    const site = await this.sites.site(asset.organizationId, asset.siteId);
    if (!site) return 'skipped';
    const object = await this.originals.get(asset.storageKey);
    if (!object) return 'skipped';
    const version = site.currentVersionId
      ? await this.sites.version(site.id, site.currentVersionId)
      : undefined;
    const look = lookOf(version?.spec, site.businessName);
    const measured = await this.images.measure(object.body);
    const result = await this.analyzer.analyze({
      organizationId: asset.organizationId,
      image: object.body,
      businessName: look.name,
      locales: look.locales,
      source: asset.source,
    });
    const alt = { ...result.alt, ...(asset.alt ?? {}) };
    const changed = await this.assets.transition(asset.id, ['ready'], {
      analysis: {
        depicts: result.depicts,
        containsText: result.containsText,
        containsPeople: result.containsPeople,
        identifiablePeople: result.identifiablePeople,
        quality: result.quality,
        heroSuitability: result.heroSuitability,
        mood: [...result.mood].slice(0, 5),
        sharpness: Math.round(measured.sharpness * 10) / 10,
      },
      alt,
      focalPoint: asset.focalPoint ?? measured.focalPoint,
    });
    if (!changed) return 'skipped';
    await this.events.record(SiteAssetAnalyzed, {
      orgId: asset.organizationId,
      payload: { siteId: asset.siteId, assetId: asset.id },
    });
    return 'analyzed';
  }

  /** The library's images ranked for a role, with the reasons (explainable). */
  async suggestions(
    actor: SiteActor,
    siteId: string,
    query: SiteAssetSuggestionsQuery,
  ): Promise<SiteAssetSuggestions> {
    const site = await this.sites.site(actor.organizationId, siteId);
    if (!site) throw new NotFoundError('Site', siteId);
    const version = site.currentVersionId
      ? await this.sites.version(site.id, site.currentVersionId)
      : undefined;
    const look = lookOf(version?.spec, site.businessName);
    const needle = query.q?.toLowerCase();
    const ready = (await this.assets.list(actor.organizationId, site.id)).filter(
      (asset) =>
        asset.status === 'ready' &&
        asset.publicUrl &&
        asset.width &&
        asset.height &&
        (!query.source || asset.source === query.source) &&
        (!needle ||
          Object.values(asset.alt ?? {})
            .join(' ')
            .toLowerCase()
            .includes(needle)),
    );
    const byId = new Map(ready.map((asset) => [asset.id, asset]));
    const ranked = rankCandidates(ready.map(rankable), { role: query.role, palette: look.palette });
    return {
      role: query.role,
      items: ranked.flatMap(({ asset, score, reasons }) => {
        const stored = byId.get(asset.id);
        return stored ? [candidateOf(stored, score, reasons)] : [];
      }),
    };
  }

  /** Records who confirmed the business owns an owner-site image, and how; lifts `preview_only`. */
  @Transactional()
  async confirmOwnership(
    actor: SiteActor,
    siteId: string,
    assetId: string,
    input: ConfirmAssetOwnershipRequest,
  ): Promise<SiteAsset> {
    const site = await this.sites.site(actor.organizationId, siteId);
    if (!site) throw new NotFoundError('Site', siteId);
    const asset = await this.assets.get(actor.organizationId, site.id, assetId);
    if (!asset) throw new NotFoundError('SiteAsset', assetId);
    if (asset.license !== 'owner_site')
      throw new ConflictError('Only images from the business’s website need an ownership confirmation.', {
        details: { reason: 'ASSET_NOT_OWNER_SITE' },
      });
    if (asset.ownership) return toAsset(asset);
    const ownership = {
      confirmedAt: this.clock.now().toISOString(),
      confirmedBy: actor.userId,
      method: input.method,
    };
    const changes = { restrictions: [] as 'preview_only'[], ownership };
    await this.assets.transition(asset.id, ['pending', 'processing', 'ready', 'failed'], changes);
    await this.events.record(SiteAssetOwnershipConfirmed, {
      orgId: actor.organizationId,
      payload: { siteId: site.id, businessId: site.businessId, assetId: asset.id, method: input.method },
    });
    return toAsset({ ...asset, ...changes });
  }
}

function rankable(asset: StoredAsset): RankableAsset {
  const analysis = asset.analysis as {
    quality?: number;
    heroSuitability?: number;
    containsText?: boolean;
    containsPeople?: boolean;
    identifiablePeople?: boolean;
  } | null;
  return {
    id: asset.id,
    kind: asset.kind === 'logo' ? 'logo' : 'photo',
    source: asset.source,
    width: asset.width ?? 1,
    height: asset.height ?? 1,
    analysis:
      analysis && typeof analysis.quality === 'number'
        ? {
            quality: analysis.quality,
            heroSuitability: analysis.heroSuitability ?? 3,
            containsText: analysis.containsText ?? false,
            containsPeople: analysis.containsPeople ?? false,
            identifiablePeople: analysis.identifiablePeople ?? false,
          }
        : null,
    dominantColors: asset.dominantColors,
  };
}

function candidateOf(asset: StoredAsset, score: number, reasons: readonly string[]): SiteAssetCandidate {
  return {
    id: `asset:${asset.id}`,
    source: asset.source,
    assetId: asset.id,
    previewUrl: asset.publicUrl,
    width: asset.width,
    height: asset.height,
    license: asset.license,
    attribution: asset.licenseDetails?.attributionText ?? asset.licenseDetails?.author ?? null,
    restrictions: asset.restrictions,
    alt: asset.alt,
    score,
    reasons: reasons.slice(0, 10).map((reason) => reason.slice(0, 120)),
  };
}
