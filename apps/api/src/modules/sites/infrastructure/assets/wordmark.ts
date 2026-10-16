import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import opentype from 'opentype.js';

// The wordmark (BF-038): when a business has no usable logo, its name set in a display font and outlined to SVG
// paths (no font to load, the same bytes on every machine), plus a monogram for the favicon. Fonts are the block
// library's static families (their WOFF files: opentype.js does not read WOFF2): DM Serif Display for serif styles,
// Lato Bold otherwise.

const require = createRequire(import.meta.url);

export type WordmarkFace = 'serif' | 'sans';

const FONT_FILES: Record<WordmarkFace, string> = {
  serif: '@fontsource/dm-serif-display/files/dm-serif-display-latin-400-normal.woff',
  sans: '@fontsource/lato/files/lato-latin-700-normal.woff',
};

const fonts = new Map<WordmarkFace, opentype.Font>();

function font(face: WordmarkFace): opentype.Font {
  const cached = fonts.get(face);
  if (cached) return cached;
  const bytes = readFileSync(require.resolve(FONT_FILES[face]));
  const parsed = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  fonts.set(face, parsed);
  return parsed;
}

export interface Wordmark {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
}

const FONT_SIZE = 96;
const PADDING = 24;
const COLOR = /^#[0-9a-fA-F]{6}$/;

/** Characters the fonts can draw (Latin): anything else is dropped rather than drawn as a missing glyph. */
function drawable(text: string, face: WordmarkFace): string {
  const f = font(face);
  return [...text.normalize('NFC')]
    .filter((char) => char === ' ' || f.charToGlyph(char).index !== 0)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The business's name as outlined paths, in `color` on a transparent background. Deterministic. */
export function wordmarkSvg(name: string, options: { face: WordmarkFace; color: string }): Wordmark {
  const color = COLOR.test(options.color) ? options.color : '#1f2937';
  const text = drawable(name, options.face).slice(0, 60) || '·';
  const f = font(options.face);
  const ascent = (f.ascender / f.unitsPerEm) * FONT_SIZE;
  const descent = (-f.descender / f.unitsPerEm) * FONT_SIZE;
  const advance = f.getAdvanceWidth(text, FONT_SIZE);
  const width = Math.ceil(advance + PADDING * 2);
  const height = Math.ceil(ascent + descent + PADDING * 2);
  const path = f.getPath(text, PADDING, PADDING + ascent, FONT_SIZE).toPathData(2);
  return {
    width,
    height,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><path fill="${color}" d="${path}"/></svg>`,
  };
}

/** The name's initials (one or two letters) in a filled circle: the favicon variant. */
export function monogramSvg(
  name: string,
  options: { face: WordmarkFace; color: string; background: string },
): Wordmark {
  const color = COLOR.test(options.color) ? options.color : '#ffffff';
  const background = COLOR.test(options.background) ? options.background : '#1f2937';
  const words = drawable(name, options.face).split(' ').filter(Boolean);
  const initials = (
    words.length > 1 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : (words[0]?.slice(0, 1) ?? '·')
  ).toUpperCase();
  const f = font(options.face);
  const size = 512;
  const fontSize = initials.length > 1 ? 220 : 280;
  const advance = f.getAdvanceWidth(initials, fontSize);
  const ascent = (f.ascender / f.unitsPerEm) * fontSize;
  const descent = (-f.descender / f.unitsPerEm) * fontSize;
  const baseline = size / 2 + (ascent - descent) / 2 - fontSize * 0.08;
  const path = f.getPath(initials, (size - advance) / 2, baseline, fontSize).toPathData(2);
  return {
    width: size,
    height: size,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="256" cy="256" r="256" fill="${background}"/><path fill="${color}" d="${path}"/></svg>`,
  };
}
