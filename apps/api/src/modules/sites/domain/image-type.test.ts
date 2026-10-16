import { describe, expect, it } from 'vitest';
import { sniffImageType } from './image-type.ts';

const bytes = (...parts: (number[] | string)[]) =>
  Uint8Array.from(
    parts.flatMap((part) => (typeof part === 'string' ? [...part].map((c) => c.charCodeAt(0)) : part)),
  );

describe('sniffImageType', () => {
  it('recognises JPEG, PNG, WebP and AVIF by their bytes', () => {
    expect(sniffImageType(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffImageType(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(bytes([0, 0, 0, 0x1c], 'ftypavif', [0, 0, 0, 0], 'mif1miaf'))).toBe('image/avif');
    expect(sniffImageType(bytes([0, 0, 0, 0x18], 'ftypmif1', [0, 0, 0, 0], 'avis'))).toBe('image/avif');
  });

  it('refuses anything else (SVG, HTML, HEIC, empty)', () => {
    expect(sniffImageType(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
    expect(sniffImageType(bytes('<!doctype html>'))).toBeUndefined();
    expect(sniffImageType(bytes([0, 0, 0, 0x18], 'ftypheic', [0, 0, 0, 0], 'mif1'))).toBeUndefined();
    expect(sniffImageType(new Uint8Array())).toBeUndefined();
  });
});
