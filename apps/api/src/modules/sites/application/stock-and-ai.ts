import { createHash } from 'node:crypto';
import {
  BudgetExceededError,
  type Clock,
  type GenerateSiteAssetsRequest,
  NotFoundError,
  newId,
  RateLimitedError,
  type SiteAsset,
  type SiteAssetCandidate,
  type SiteAssetGeneration,
  type SiteAssetSources,
  ValidationError,
} from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { LOGGER } from '../../platform/logging/logger.ts';
import type { ObjectStorage } from '../../platform/storage/object-storage.ts';
import { judgeImagePrompt } from '../domain/assets/image-prompt-policy.ts';
import {
  attributionFor,
  LICENSING_PROFILES,
  type StockProviderName,
} from '../domain/assets/licensing-profile.ts';
import { MAX_IMAGE_PIXELS, sniffImageType } from '../domain/image-type.ts';
import { IMAGE_FETCHER, type ImageFetcher } from './asset-sourcing.ts';
import {
  ASSET_PROCESSING_QUEUE,
  type AssetProcessingQueue,
  IMAGE_PROCESSOR,
  type ImageProcessor,
  SITE_ASSETS_REPOSITORY,
  SITE_ORIGINALS,
  SITES_REPOSITORY,
  type SiteAssetsRepository,
  type SitesRepository,
} from './ports.ts';
import { toAsset } from './site-assets.ts';
import type { SiteActor } from './sites.commands.ts';

// Stock and AI images (BF-038 part 2), into the same library as uploads and owner-site images. Stock photos follow
// their provider's licensing profile (Unsplash: hotlinked, download tracked when picked, credited; Pexels: our copy,
// credited). AI images are illustrative only: the prompt is checked against the policy here, the template says it
// again, and the vision analysis discards any result showing people or text. Budgets and a daily cap apply.

export interface StockPhoto {
  readonly provider: StockProviderName;
  readonly id: string;
  /** A small preview for the picker. */
  readonly previewUrl: string;
  /** The image to use: the hotlink base (Unsplash `urls.raw`) or the file to copy (Pexels `src.original`). */
  readonly imageUrl: string;
  readonly width: number;
  readonly height: number;
  readonly author: string;
  readonly authorUrl: string;
  readonly pageUrl: string;
  readonly alt: string | null;
  readonly color: string | null;
  /** Unsplash: the endpoint to call when a person picks the photo. */
  readonly downloadLocation: string | null;
}

export interface StockProvider {
  readonly name: StockProviderName;
  /** Whether the workspace (or the deployment) has a key for it. */
  available(organizationId: string): Promise<boolean>;
  search(
    organizationId: string,
    query: string,
    options: { readonly orientation?: 'landscape' | 'portrait' | 'squarish'; readonly page?: number },
  ): Promise<readonly StockPhoto[]>;
  photo(organizationId: string, id: string): Promise<StockPhoto | undefined>;
  /** The provider's download tracking (only where its profile requires it). */
  trackDownload(organizationId: string, photo: StockPhoto): Promise<void>;
}
export const STOCK_PROVIDERS = Symbol('StockProviders');

/** An image model behind the AI source (OpenAI images; a deterministic fake in tests and E2E). */
export interface ImageGenerator {
  readonly model: string;
  available(organizationId: string): Promise<boolean>;
  generate(input: {
    readonly organizationId: string;
    readonly prompt: string;
    readonly aspect: GenerateSiteAssetsRequest['aspect'];
    readonly count: number;
  }): Promise<readonly Buffer[]>;
}
export const IMAGE_GENERATOR = Symbol('ImageGenerator');

/** The workspace's AI budget state and its daily image count (Valkey). */
export interface AiImageAllowance {
  budget(organizationId: string): Promise<'ok' | 'soft' | 'hard'>;
  /** Images generated today. */
  usedToday(organizationId: string): Promise<number>;
  /** Reserves `count` images of today's cap; false (nothing reserved) when it would go past `cap`. */
  reserve(organizationId: string, count: number, cap: number): Promise<boolean>;
  /** The ledger entry of a generation (cost counted against budgets). */
  record(input: {
    readonly organizationId: string;
    readonly model: string;
    readonly images: number;
    readonly costUsd: number;
    readonly latencyMs: number;
    readonly status: 'ok' | 'error';
  }): Promise<void>;
}
export const AI_IMAGE_ALLOWANCE = Symbol('AiImageAllowance');

export interface AiImageSettings {
  readonly dailyCap: number;
  readonly priceUsd: number;
  readonly unsplashAppName: string;
}
export const AI_IMAGE_SETTINGS = Symbol('AiImageSettings');

/** Queues a generation (the job calls `runGeneration`). */
export interface GenerationQueue {
  generate(input: {
    readonly organizationId: string;
    readonly siteId: string;
    readonly generationId: string;
    readonly prompt: string;
    readonly aspect: GenerateSiteAssetsRequest['aspect'];
    readonly count: number;
  }): Promise<void>;
}
export const GENERATION_QUEUE = Symbol('GenerationQueue');

const ASPECT_SIZES: Record<GenerateSiteAssetsRequest['aspect'], string> = {
  '16:9': '1536x1024',
  '4:3': '1536x1024',
  '1:1': '1024x1024',
  '3:4': '1024x1536',
};
export const sizeForAspect = (aspect: GenerateSiteAssetsRequest['aspect']) => ASPECT_SIZES[aspect];

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Unsplash links carry the app's referral parameters (its guidelines). */
export function withReferral(url: string, appName: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('utm_source', appName);
    parsed.searchParams.set('utm_medium', 'referral');
    return parsed.toString();
  } catch {
    return url;
  }
}

/** A hotlinked Unsplash image at a width: the provider's resizing parameters on `urls.raw` (keeps its `ixid`). */
export function unsplashSized(raw: string, width: number): string {
  const url = new URL(raw);
  url.searchParams.set('w', String(width));
  url.searchParams.set('q', '80');
  url.searchParams.set('fm', 'jpg');
  url.searchParams.set('fit', 'max');
  return url.toString();
}

@Injectable()
export class StockAndAiImages {
  constructor(
    @Inject(SITES_REPOSITORY) private readonly sites: SitesRepository,
    @Inject(SITE_ASSETS_REPOSITORY) private readonly assets: SiteAssetsRepository,
    @Inject(SITE_ORIGINALS) private readonly originals: ObjectStorage,
    @Inject(IMAGE_PROCESSOR) private readonly images: ImageProcessor,
    @Inject(ASSET_PROCESSING_QUEUE) private readonly processing: AssetProcessingQueue,
    @Inject(IMAGE_FETCHER) private readonly fetcher: ImageFetcher,
    @Inject(STOCK_PROVIDERS) private readonly stock: readonly StockProvider[],
    @Inject(IMAGE_GENERATOR) private readonly generator: ImageGenerator,
    @Inject(AI_IMAGE_ALLOWANCE) private readonly allowance: AiImageAllowance,
    @Inject(AI_IMAGE_SETTINGS) private readonly settings: AiImageSettings,
    @Inject(GENERATION_QUEUE) private readonly generations: GenerationQueue,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(LOGGER) private readonly logger?: Logger,
  ) {}

  private async site(actor: SiteActor, siteId: string) {
    const site = await this.sites.site(actor.organizationId, siteId);
    if (!site) throw new NotFoundError('Site', siteId);
    return site;
  }

  /** The configured stock providers and today's AI allowance (the editor shows its "Find more images" tab). */
  async sources(actor: SiteActor, siteId: string): Promise<SiteAssetSources> {
    await this.site(actor, siteId);
    const stock: string[] = [];
    for (const provider of this.stock)
      if (await provider.available(actor.organizationId)) stock.push(provider.name);
    const enabled =
      this.settings.dailyCap > 0 &&
      (await this.generator.available(actor.organizationId)) &&
      (await this.allowance.budget(actor.organizationId)) !== 'hard';
    const used = enabled ? await this.allowance.usedToday(actor.organizationId) : 0;
    return {
      stock,
      ai: { enabled, remainingToday: enabled ? Math.max(0, this.settings.dailyCap - used) : 0 },
    };
  }

  /** Stock photos for a query, across the available providers (cached and rate-limited by the adapters). */
  async search(
    actor: SiteActor,
    siteId: string,
    query: string,
    orientation?: 'landscape' | 'portrait' | 'squarish',
  ): Promise<SiteAssetCandidate[]> {
    await this.site(actor, siteId);
    const out: SiteAssetCandidate[] = [];
    for (const provider of this.stock) {
      if (!(await provider.available(actor.organizationId))) continue;
      try {
        const photos = await provider.search(actor.organizationId, query, orientation ? { orientation } : {});
        out.push(...photos.map((photo) => this.candidate(photo)));
      } catch (error) {
        // One provider down or out of quota: the others still answer.
        this.logger?.warn({ provider: provider.name, err: error }, 'stock search failed');
      }
    }
    return out;
  }

  private candidate(photo: StockPhoto): SiteAssetCandidate {
    const profile = LICENSING_PROFILES[photo.provider];
    return {
      id: `stock:${photo.provider}:${photo.id}`,
      source: 'stock',
      assetId: null,
      previewUrl: photo.previewUrl,
      width: photo.width,
      height: photo.height,
      license: 'stock',
      attribution: attributionFor(profile, photo.author) ?? null,
      provider: photo.provider,
      restrictions: [],
      alt: photo.alt ? { en: photo.alt.slice(0, 150) } : null,
      score: 50,
      reasons: [`stock photo (${photo.provider})`],
    };
  }

  /**
   * Brings a stock photo into the site's library: hotlinked (Unsplash, its download tracked now — a person picked
   * it) or copied through intel's guarded download (Pexels), credited per the provider's profile. Idempotent.
   */
  async importStock(actor: SiteActor, siteId: string, candidateId: string): Promise<SiteAsset> {
    const site = await this.site(actor, siteId);
    const [, name, id] = candidateId.split(':') as [string, string, string];
    const provider = this.stock.find((candidate) => candidate.name === name);
    if (!provider || !(await provider.available(actor.organizationId)))
      throw new ValidationError('This stock provider is not configured.', [
        { path: ['candidateId'], message: 'Unknown or unconfigured provider', code: 'provider' },
      ]);
    const photo = await provider.photo(actor.organizationId, id);
    if (!photo) throw new NotFoundError('StockPhoto', candidateId);
    const sourceUrl = photo.pageUrl;
    const existing = (await this.assets.list(actor.organizationId, site.id)).find(
      (asset) => asset.sourceUrl === sourceUrl,
    );
    if (existing) return toAsset(existing);
    const profile = LICENSING_PROFILES[photo.provider];
    const appName = this.settings.unsplashAppName;
    const licenseDetails = {
      provider: photo.provider,
      author: photo.author.slice(0, 120),
      attributionText: attributionFor(profile, photo.author) ?? '',
      authorUrl: photo.provider === 'unsplash' ? withReferral(photo.authorUrl, appName) : photo.authorUrl,
      sourceUrl: photo.provider === 'unsplash' ? withReferral(photo.pageUrl, appName) : photo.pageUrl,
    };
    const alt = photo.alt ? { en: photo.alt.slice(0, 150) } : null;
    const id_ = newId();
    const storageKey = `orgs/${actor.organizationId}/sites/${site.id}/assets/${id_}/original`;
    if (profile.hosting === 'hotlink') {
      // No copy: the provider's CDN serves it at any width (the renderer builds the srcset from its parameters).
      const inserted = await this.assets.insert({
        id: id_,
        organizationId: actor.organizationId,
        siteId: site.id,
        storageKey,
        mime: 'image/jpeg',
        bytes: null,
        license: 'stock',
        licenseDetails,
        alt,
        kind: 'image',
        hosting: 'hotlink',
        source: 'stock',
        sourceUrl,
        createdBy: actor.userId,
      });
      await this.assets.transition(inserted.id, ['pending'], {
        status: 'ready',
        width: photo.width,
        height: photo.height,
        publicUrl: unsplashSized(photo.imageUrl, Math.min(1200, photo.width)),
        variants: [],
        dominantColors:
          photo.color && /^#[0-9a-f]{6}$/i.test(photo.color) ? [photo.color.toLowerCase()] : null,
      });
      if (profile.downloadTrackingRequired)
        await provider
          .trackDownload(actor.organizationId, photo)
          .catch((error: unknown) =>
            this.logger?.warn({ provider: photo.provider, err: error }, 'stock download tracking failed'),
          );
      const stored = await this.assets.byId(inserted.id);
      if (!stored) throw new NotFoundError('SiteAsset', inserted.id);
      return toAsset(stored);
    }
    // Our copy, downloaded through intel's guard (the provider's CDN is still a URL from outside).
    const bytes = Buffer.from(await this.fetcher.fetch(photo.imageUrl));
    const mime = sniffImageType(bytes);
    if (!mime) throw new ValidationError('The stock photo is not an image we accept.', []);
    const size = await this.images.inspect(bytes);
    if (size.width * size.height > MAX_IMAGE_PIXELS)
      throw new ValidationError('The stock photo is too large.', []);
    await this.originals.put(storageKey, bytes, mime);
    const inserted = await this.assets.insert({
      id: id_,
      organizationId: actor.organizationId,
      siteId: site.id,
      storageKey,
      mime,
      bytes: bytes.length,
      license: 'stock',
      licenseDetails,
      alt,
      kind: 'image',
      source: 'stock',
      sourceUrl,
      createdBy: actor.userId,
    });
    const checked = {
      status: 'processing' as const,
      width: size.width,
      height: size.height,
      sha256: sha256(bytes),
    };
    await this.assets.transition(inserted.id, ['pending'], checked);
    await this.processing.process(inserted.id, actor.organizationId);
    return toAsset({ ...inserted, ...checked });
  }

  /** Checks the prompt, the budget and today's cap, then queues the generation (the images arrive in the library). */
  async generate(
    actor: SiteActor,
    siteId: string,
    input: GenerateSiteAssetsRequest,
  ): Promise<SiteAssetGeneration> {
    const site = await this.site(actor, siteId);
    const verdict = judgeImagePrompt(input.prompt);
    if (!verdict.ok)
      throw new ValidationError(
        'AI images are illustrations only: no people, text, logos, brands or the business’s real premises.',
        [{ path: ['prompt'], message: 'Not allowed by the image policy', code: verdict.reason }],
      );
    if (this.settings.dailyCap === 0 || !(await this.generator.available(actor.organizationId)))
      throw new ValidationError('AI images are not configured.', [
        { path: ['prompt'], message: 'No image model', code: 'not_configured' },
      ]);
    if ((await this.allowance.budget(actor.organizationId)) === 'hard')
      throw new BudgetExceededError('The workspace’s AI budget for this month is spent.');
    if (!(await this.allowance.reserve(actor.organizationId, input.count, this.settings.dailyCap)))
      throw new RateLimitedError('Today’s AI images are used up: try again tomorrow.');
    const generationId = newId();
    await this.generations.generate({
      organizationId: actor.organizationId,
      siteId: site.id,
      generationId,
      prompt: input.prompt,
      aspect: input.aspect,
      count: input.count,
    });
    return { generationId, count: input.count };
  }

  /**
   * The generation job: the model's images stored as `ai_generated` library images (processed, then analysed: the
   * analysis discards any showing people or text). Idempotent per generation (its images are keyed by it).
   */
  async runGeneration(input: Parameters<GenerationQueue['generate']>[0]): Promise<number> {
    const site = await this.sites.site(input.organizationId, input.siteId);
    if (!site) return 0;
    const known = new Set(
      (await this.assets.list(input.organizationId, site.id)).flatMap((asset) => asset.sourceUrl ?? []),
    );
    if (known.has(`ai:${input.generationId}:0`)) return 0;
    const started = this.clock.now().getTime();
    let images: readonly Buffer[];
    try {
      images = await this.generator.generate(input);
    } catch (error) {
      await this.allowance.record({
        organizationId: input.organizationId,
        model: this.generator.model,
        images: 0,
        costUsd: 0,
        latencyMs: this.clock.now().getTime() - started,
        status: 'error',
      });
      throw error;
    }
    await this.allowance.record({
      organizationId: input.organizationId,
      model: this.generator.model,
      images: images.length,
      costUsd: images.length * this.settings.priceUsd,
      latencyMs: this.clock.now().getTime() - started,
      status: 'ok',
    });
    const promptHash = sha256(input.prompt).slice(0, 16);
    let stored = 0;
    for (const [index, bytes] of images.entries()) {
      const mime = sniffImageType(bytes);
      if (!mime) continue;
      const size = await this.images.inspect(bytes);
      const id = newId();
      const storageKey = `orgs/${input.organizationId}/sites/${site.id}/assets/${id}/original`;
      await this.originals.put(storageKey, bytes, mime);
      await this.assets.insert({
        id,
        organizationId: input.organizationId,
        siteId: site.id,
        storageKey,
        mime,
        bytes: bytes.length,
        license: 'ai_generated',
        licenseDetails: { provider: 'openai', model: this.generator.model, promptHash },
        alt: null,
        kind: 'image',
        source: 'ai',
        sourceUrl: `ai:${input.generationId}:${index}`,
        createdBy: null,
      });
      await this.assets.transition(id, ['pending'], {
        status: 'processing',
        width: size.width,
        height: size.height,
        sha256: sha256(bytes),
      });
      await this.processing.process(id, input.organizationId);
      stored++;
    }
    return stored;
  }
}
