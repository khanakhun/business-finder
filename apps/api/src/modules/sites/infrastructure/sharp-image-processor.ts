import sharp from 'sharp';
import type { ImageProcessor } from '../application/ports.ts';
import { DHASH_HEIGHT, DHASH_WIDTH, dhash, laplacianVariance } from '../domain/assets/dhash.ts';
import { DECODABLE_FORMATS, MAX_IMAGE_PIXELS } from '../domain/image-type.ts';

/** Decoding stops on corrupt data and above the pixel limit (decompression bombs). */
const decode = (image: Buffer) => sharp(image, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' });

/** Refuses anything but the accepted types before decoding it (libvips also reads SVG, TIFF, GIF…). */
async function checkedFormat(image: Buffer) {
  const metadata = await decode(image).metadata();
  if (!DECODABLE_FORMATS.has(metadata.format))
    throw new Error(`Unsupported image format: ${metadata.format}`);
  return metadata;
}

const hex = (value: number) => Math.round(value).toString(16).padStart(2, '0');

/**
 * Images with sharp (libvips): oriented by their EXIF tag, then written without any metadata (sharp drops EXIF, GPS,
 * ICC comments unless asked to keep them), resized down only.
 */
export class SharpImageProcessor implements ImageProcessor {
  async inspect(image: Buffer): Promise<{ width: number; height: number }> {
    const metadata = await checkedFormat(image);
    return { width: metadata.autoOrient.width, height: metadata.autoOrient.height };
  }

  async measure(image: Buffer) {
    const metadata = await checkedFormat(image);
    const grey = await decode(image)
      .autoOrient()
      .greyscale()
      .resize(DHASH_WIDTH, DHASH_HEIGHT, { fit: 'fill' })
      .raw()
      .toBuffer();
    const sample = await decode(image)
      .autoOrient()
      .greyscale()
      .resize({ width: 512, height: 512, fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    // The saliency crop of a square: its attention point is in the scaled (pre-crop) frame.
    const side = 256;
    const { width, height } = metadata.autoOrient;
    const scale = side / Math.min(width, height);
    const crop = await decode(image)
      .autoOrient()
      .resize(side, side, { fit: 'cover', position: sharp.strategy.attention })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const info = crop.info as typeof crop.info & { attentionX?: number; attentionY?: number };
    const unit = (value: number) => Math.min(1, Math.max(0, Math.round(value * 100) / 100));
    return {
      dhash: dhash(new Uint8Array(grey)),
      sharpness: laplacianVariance(new Uint8Array(sample.data), sample.info.width, sample.info.height),
      focalPoint: {
        x: unit((info.attentionX ?? (width * scale) / 2) / (width * scale)),
        y: unit((info.attentionY ?? (height * scale) / 2) / (height * scale)),
      },
    };
  }

  async rasterizeSvg(svg: string, width: number): Promise<Buffer> {
    // Our own SVG (paths only, no external references): rendered by librsvg, written as PNG without metadata.
    return sharp(Buffer.from(svg), { limitInputPixels: MAX_IMAGE_PIXELS }).resize({ width }).png().toBuffer();
  }

  async variants(image: Buffer, widths: readonly number[]) {
    await checkedFormat(image);
    const out: { width: number; format: 'webp' | 'avif'; body: Buffer }[] = [];
    // One encoding at a time: a 40 MP image decodes to about 160 MB.
    for (const width of widths) {
      const resize = () => decode(image).autoOrient().resize({ width, withoutEnlargement: true });
      const webp = await resize().webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
      out.push({ width: webp.info.width, format: 'webp', body: webp.data });
      const avif = await resize().avif({ quality: 55, effort: 4 }).toBuffer({ resolveWithObject: true });
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
