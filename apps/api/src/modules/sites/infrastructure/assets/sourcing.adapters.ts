import { createHash } from 'node:crypto';
import { type AiGateway, AssetsAnalyzeImage } from '@bf/ai';
import { IMAGE_FETCH_MAX_BYTES, ImageFetchRequestSchema } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { orgBusinesses, websiteSnapshots } from '@bf/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { IntelClient } from '../../../platform/intel/intel-client.ts';
import type {
  ImageAnalysis,
  ImageAnalyzer,
  ImageFetcher,
  OwnerSiteImages,
  OwnerSiteImagesReader,
  WordmarkMaker,
} from '../../application/asset-sourcing.ts';
import type { ImageProcessor } from '../../application/ports.ts';
import { monogramSvg, wordmarkSvg } from './wordmark.ts';

// Adapters of image sourcing (BF-038): the business's latest website snapshot (BF-026), downloads through
// services/intel, the wordmark renderer, and the vision analysis (the AI gateway, or a deterministic fake).

/** The latest snapshot of the business's website that the workspace tracks (org-scoped through org_businesses). */
export class DrizzleOwnerSiteImages implements OwnerSiteImagesReader {
  constructor(private readonly db: DbClient) {}

  async latest(organizationId: string, businessId: string): Promise<OwnerSiteImages | undefined> {
    const [row] = await getExecutor(this.db)
      .select({ images: websiteSnapshots.imageCandidates, logos: websiteSnapshots.logoCandidates })
      .from(websiteSnapshots)
      .innerJoin(
        orgBusinesses,
        and(
          eq(orgBusinesses.businessId, websiteSnapshots.businessId),
          eq(orgBusinesses.organizationId, organizationId),
        ),
      )
      .where(and(eq(websiteSnapshots.businessId, businessId), eq(websiteSnapshots.reachability, 'ok')))
      .orderBy(desc(websiteSnapshots.fetchedAt))
      .limit(1);
    if (!row) return undefined;
    return {
      images: row.images.map((image) => ({ url: image.url, alt: image.alt })),
      logos: row.logos.map((logo) => ({ url: logo.url })),
    };
  }
}

/** `POST /v1/image-fetch` on services/intel: the API never fetches crawled URLs itself (security.md §4). */
export class IntelImageFetcher implements ImageFetcher {
  constructor(private readonly intel: IntelClient) {}

  async fetch(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    const body = ImageFetchRequestSchema.parse({ url, maxBytes: IMAGE_FETCH_MAX_BYTES, timeoutSeconds: 20 });
    return this.intel.postForBytes('/v1/image-fetch', body, {
      policy: 'intel-image',
      maxBytes: IMAGE_FETCH_MAX_BYTES,
      ...(signal ? { signal } : {}),
    });
  }
}

/**
 * Downloads without a network (tests and E2E, `FAKE_SITE_INTEL`; refused in production): a 960 × 640 photo (or
 * a 400 × 160 logo when the URL names one) coloured from the URL's hash, so each URL is its own picture.
 */
export class FakeImageFetcher implements ImageFetcher {
  async fetch(url: string): Promise<Uint8Array> {
    const digest = createHash('sha256').update(url).digest();
    const logo = /logo/i.test(url);
    const [width, height] = logo ? [400, 160] : [960, 640];
    // Large blocks placed from the hash (so each URL has its own difference hash) over a fine grain (edges: a flat
    // image counts as blurry). A seeded xorshift: the same URL always gives the same bytes.
    let seed = digest.readUInt32BE(0) || 1;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 4_294_967_296;
    };
    const cells = 4;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const cell = Math.floor((y / height) * cells) * cells + Math.floor((x / width) * cells);
        const base = digest[cell % 32] ?? 0;
        const grain = (random() - 0.5) * 120;
        const at = (y * width + x) * 3;
        pixels[at] = Math.max(0, Math.min(255, base + grain));
        pixels[at + 1] = Math.max(0, Math.min(255, (digest[(cell + 7) % 32] ?? 0) + grain));
        pixels[at + 2] = Math.max(0, Math.min(255, (digest[(cell + 13) % 32] ?? 0) + grain));
      }
    }
    return new Uint8Array(
      await sharp(pixels, { raw: { width, height, channels: 3 } })
        .jpeg({ quality: 85 })
        .toBuffer(),
    );
  }
}

/** The wordmark (1200 px wide) and its monogram (512 px) as PNGs, keyed by what was drawn. */
export class OpentypeWordmarkMaker implements WordmarkMaker {
  constructor(private readonly images: Pick<ImageProcessor, 'rasterizeSvg'>) {}

  async make(input: Parameters<WordmarkMaker['make']>[0]) {
    const mark = wordmarkSvg(input.name, { face: input.face, color: input.color });
    const mono = monogramSvg(input.name, { face: input.face, color: '#ffffff', background: input.color });
    return {
      logo: await this.images.rasterizeSvg(mark.svg, 1200),
      favicon: await this.images.rasterizeSvg(mono.svg, 512),
      key: createHash('sha256').update(mark.svg).update(mono.svg).digest('hex').slice(0, 24),
    };
  }
}

/** `assets.analyze_image` (fast tier) through the AI gateway: budgeted, metered, the image as data. */
export class AiImageAnalyzer implements ImageAnalyzer {
  constructor(private readonly gateway: AiGateway) {}

  async analyze(input: Parameters<ImageAnalyzer['analyze']>[0]): Promise<ImageAnalysis> {
    const { output } = await this.gateway.vision(
      AssetsAnalyzeImage,
      {
        input: {
          businessName: input.businessName.slice(0, 200),
          locales: input.locales.slice(0, 5),
          source: input.source,
        },
        images: [{ bytes: new Uint8Array(input.image) }],
      },
      { orgId: input.organizationId },
    );
    const wanted = new Set(input.locales);
    return {
      depicts: output.depicts,
      containsText: output.containsText,
      containsPeople: output.containsPeople,
      identifiablePeople: output.identifiablePeople,
      quality: output.quality,
      heroSuitability: output.heroSuitability,
      mood: output.mood,
      alt: Object.fromEntries(
        output.alt.filter((entry) => wanted.has(entry.locale)).map((entry) => [entry.locale, entry.text]),
      ),
    };
  }
}

/** A deterministic analysis (tests and E2E; no model call): a good, landscape-friendly photo, with generic alt texts. */
export class FakeImageAnalyzer implements ImageAnalyzer {
  async analyze(input: Parameters<ImageAnalyzer['analyze']>[0]): Promise<ImageAnalysis> {
    const words: Record<string, string> = { fr: 'Photo de l’établissement', en: 'Photo of the business' };
    return {
      depicts: 'interior',
      containsText: false,
      containsPeople: false,
      identifiablePeople: false,
      quality: 4,
      heroSuitability: 4,
      mood: ['bright'],
      alt: Object.fromEntries(
        input.locales.map((locale) => [
          locale,
          `${words[locale] ?? words.en} ${input.businessName}`.slice(0, 125),
        ]),
      ),
    };
  }
}
