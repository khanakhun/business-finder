import sharp from 'sharp';

/** An image for a vision task: a URL the provider fetches, or bytes we resize first. */
export type AiImage = { readonly url: string } | { readonly bytes: Uint8Array; readonly mediaType?: string };

/** Longest side sent to models unless the task says otherwise (legible, without paying for pixels). */
export const DEFAULT_MAX_IMAGE_DIMENSION = 1568;

export interface PreparedImage {
  readonly image: URL | Uint8Array;
  readonly mediaType?: string;
}

/**
 * Bytes are re-encoded as JPEG (quality 80) no larger than `maxDimension` on their longest side (ai-engineering.md
 * §8); URLs are passed through (http/https only).
 */
export async function prepareImage(
  image: AiImage,
  maxDimension = DEFAULT_MAX_IMAGE_DIMENSION,
): Promise<PreparedImage> {
  if ('url' in image) {
    const url = new URL(image.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Image URLs must be http(s)');
    return { image: url };
  }
  const resized = await sharp(image.bytes, { limitInputPixels: 50_000_000 })
    .rotate()
    .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  return { image: new Uint8Array(resized), mediaType: 'image/jpeg' };
}
