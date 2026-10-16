// Near-duplicate detection and sharpness (BF-038), on grey pixels the infrastructure extracts: pure arithmetic.

/** The grey copy a difference hash reads: 9 × 8 pixels, row by row. */
export const DHASH_WIDTH = 9;
export const DHASH_HEIGHT = 8;
/** Two images within this Hamming distance are the same picture (resized, recompressed, lightly cropped). */
export const DUPLICATE_DISTANCE = 6;

/** The 64-bit difference hash (16 hex characters): each bit says whether a pixel is brighter than its right one. */
export function dhash(grey: Uint8Array): string {
  if (grey.length !== DHASH_WIDTH * DHASH_HEIGHT) throw new Error('dhash needs a 9 × 8 grey image');
  let hex = '';
  for (let row = 0; row < DHASH_HEIGHT; row++) {
    let byte = 0;
    for (let col = 0; col < DHASH_WIDTH - 1; col++) {
      const left = grey[row * DHASH_WIDTH + col] ?? 0;
      const right = grey[row * DHASH_WIDTH + col + 1] ?? 0;
      byte = (byte << 1) | (left > right ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Differing bits between two hashes (64 when they cannot be compared). */
export function hamming(a: string, b: string): number {
  if (a.length !== 16 || b.length !== 16) return 64;
  let distance = 0;
  for (let i = 0; i < 16; i += 4) {
    let x = Number.parseInt(a.slice(i, i + 4), 16) ^ Number.parseInt(b.slice(i, i + 4), 16);
    while (x) {
      distance += x & 1;
      x >>>= 1;
    }
  }
  return distance;
}

/** Whether `hash` is a near-duplicate of one of `known`. */
export function isNearDuplicate(hash: string, known: readonly string[]): boolean {
  return known.some((other) => hamming(hash, other) <= DUPLICATE_DISTANCE);
}

/**
 * Sharpness as the variance of the Laplacian (4-neighbour kernel) over a grey image: edges give large responses, a
 * blurry image small ones. Compare values of images measured at the same size.
 */
export function laplacianVariance(grey: Uint8Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const at = (dx: number, dy: number) => grey[(y + dy) * width + x + dx] ?? 0;
      const value = at(0, -1) + at(-1, 0) + at(1, 0) + at(0, 1) - 4 * at(0, 0);
      sum += value;
      sumSquares += value * value;
      count++;
    }
  }
  const mean = sum / count;
  return sumSquares / count - mean * mean;
}
