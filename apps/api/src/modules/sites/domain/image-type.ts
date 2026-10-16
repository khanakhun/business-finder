// The type of an uploaded image from its first bytes (BF-035): the declared type is never trusted.

export type SiteImageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif';

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  signature.every((byte, i) => bytes[offset + i] === byte);

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, to));

/** The image type the bytes are, among those a site accepts; undefined for anything else. */
export function sniffImageType(bytes: Uint8Array): SiteImageType | undefined {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  // ISO-BMFF: a `ftyp` box whose major brand (or a compatible one) is AVIF.
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const size =
      (((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)) >>> 0;
    const end = Math.min(size, bytes.length, 64);
    for (let at = 8; at + 4 <= end; at += 4)
      if (['avif', 'avis'].includes(ascii(bytes, at, at + 4))) return 'image/avif';
  }
  return undefined;
}

/** Images larger than this many pixels are refused (decompression bombs: 40 MP is about 160 MB decoded). */
export const MAX_IMAGE_PIXELS = 40_000_000;

/** What the decoder may read (sharp's names): the types above only, never SVG, TIFF, GIF or others it knows. */
export const DECODABLE_FORMATS: ReadonlySet<string> = new Set(['jpeg', 'png', 'webp', 'heif']);
