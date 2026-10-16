import sharp from 'sharp';
import type { ImageProcessor } from '../application/ports.ts';
import { MAX_PIXELS } from '../application/site-assets.ts';

/** Decoding stops on corrupt data and above the pixel limit (decompression bombs). */
const decode = (image: Buffer) => sharp(image, { limitInputPixels: MAX_PIXELS, failOn: 'error' });

const hex = (value: number) => Math.round(value).toString(16).padStart(2, '0');

/**
 * Images with sharp (libvips): oriented by their EXIF tag, then written without any metadata (sharp drops EXIF, GPS,
 * ICC comments unless asked to keep them), resized down only.
 */
export class SharpImageProcessor implements ImageProcessor {
  async inspect(image: Buffer): Promise<{ width: number; height: number }> {
    const metadata = await decode(image).metadata();
    return { width: metadata.autoOrient.width, height: metadata.autoOrient.height };
  }

  async variants(image: Buffer, widths: readonly number[]) {
    const out: { width: number; format: 'webp' | 'avif'; body: Buffer }[] = [];
    for (const width of widths) {
      const resized = decode(image).autoOrient().resize({ width, withoutEnlargement: true });
      const [webp, avif] = await Promise.all([
        resized.clone().webp({ quality: 80 }).toBuffer({ resolveWithObject: true }),
        resized.clone().avif({ quality: 55, effort: 4 }).toBuffer({ resolveWithObject: true }),
      ]);
      out.push({ width: webp.info.width, format: 'webp', body: webp.data });
      out.push({ width: avif.info.width, format: 'avif', body: avif.data });
    }
    return out;
  }

  /** The most frequent colours of a 32×32 thumbnail, in buckets of 16 levels per channel (`#rrggbb`). */
  async dominantColors(image: Buffer, count: number): Promise<string[]> {
    const { data, info } = await decode(image)
      .autoOrient()
      .resize(32, 32, { fit: 'inside' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
    for (let i = 0; i + 2 < data.length; i += info.channels) {
      const [r, g, b] = [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      buckets.set(key, { n: bucket.n + 1, r: bucket.r + r, g: bucket.g + g, b: bucket.b + b });
    }
    return [...buckets.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, count)
      .map((bucket) => `#${hex(bucket.r / bucket.n)}${hex(bucket.g / bucket.n)}${hex(bucket.b / bucket.n)}`);
  }
}
