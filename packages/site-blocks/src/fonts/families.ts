import { FONT_PAIRS, type FontPairId } from '@bf/site-schema';

// The self-hosted font files (BF-034): every family of the curated pairs (`@bf/site-schema` FONT_PAIRS), from its
// Fontsource package, latin and latin-ext subsets only (French accents, no other scripts). The build copies them to
// dist/fonts/ and writes their @font-face rules; nothing is fetched from a font service at runtime.

export interface FontFamilyFiles {
  /** The family name the pairs use (and the @font-face rules declare). */
  readonly family: string;
  /** The Fontsource package the files come from. */
  readonly pkg: string;
  /** Variable (one file per style, all weights) or static weights. */
  readonly axes:
    | { readonly variable: true }
    | { readonly variable: false; readonly weights: readonly number[] };
  /** The file name prefix in the package (`inter` → `inter-latin-wght-normal.woff2`). */
  readonly slug: string;
}

export const FONT_FAMILIES: readonly FontFamilyFiles[] = [
  {
    family: 'Playfair Display',
    pkg: '@fontsource-variable/playfair-display',
    axes: { variable: true },
    slug: 'playfair-display',
  },
  { family: 'Inter', pkg: '@fontsource-variable/inter', axes: { variable: true }, slug: 'inter' },
  {
    family: 'Cormorant Garamond',
    pkg: '@fontsource-variable/cormorant-garamond',
    axes: { variable: true },
    slug: 'cormorant-garamond',
  },
  {
    family: 'Montserrat',
    pkg: '@fontsource-variable/montserrat',
    axes: { variable: true },
    slug: 'montserrat',
  },
  {
    family: 'DM Serif Display',
    pkg: '@fontsource/dm-serif-display',
    axes: { variable: false, weights: [400] },
    slug: 'dm-serif-display',
  },
  { family: 'DM Sans', pkg: '@fontsource-variable/dm-sans', axes: { variable: true }, slug: 'dm-sans' },
  { family: 'Fraunces', pkg: '@fontsource-variable/fraunces', axes: { variable: true }, slug: 'fraunces' },
  { family: 'Work Sans', pkg: '@fontsource-variable/work-sans', axes: { variable: true }, slug: 'work-sans' },
  {
    family: 'Space Grotesk',
    pkg: '@fontsource-variable/space-grotesk',
    axes: { variable: true },
    slug: 'space-grotesk',
  },
  { family: 'Manrope', pkg: '@fontsource-variable/manrope', axes: { variable: true }, slug: 'manrope' },
  {
    family: 'Josefin Sans',
    pkg: '@fontsource-variable/josefin-sans',
    axes: { variable: true },
    slug: 'josefin-sans',
  },
  { family: 'Lato', pkg: '@fontsource/lato', axes: { variable: false, weights: [400, 700] }, slug: 'lato' },
];

export const FONT_SUBSETS = ['latin', 'latin-ext'] as const;

/** The CSS font stack of a family: the self-hosted font, then the pair's fallback. */
const stack = (font: { readonly family: string; readonly fallback: string }) =>
  `"${font.family}", ${font.fallback}`;

/** A pair's heading and body font stacks. */
export function fontStacks(pairId: FontPairId): { heading: string; body: string } {
  const pair = FONT_PAIRS.find((candidate) => candidate.id === pairId) ?? FONT_PAIRS[0];
  return { heading: stack(pair.heading), body: stack(pair.body) };
}

/** The file holding a family's upright latin glyphs (what a page needs first; preloaded by the static renderer). */
export function primaryFontFile(family: string): string | undefined {
  const files = FONT_FAMILIES.find((candidate) => candidate.family === family);
  if (!files) return undefined;
  return files.axes.variable
    ? `${files.slug}-latin-wght-normal.woff2`
    : `${files.slug}-latin-${files.axes.weights[0]}-normal.woff2`;
}

/** The files to preload for a pair: its heading and body upright latin files (one when both are the same family). */
export function pairPreloads(pairId: FontPairId): string[] {
  const pair = FONT_PAIRS.find((candidate) => candidate.id === pairId) ?? FONT_PAIRS[0];
  const files = [primaryFontFile(pair.heading.family), primaryFontFile(pair.body.family)];
  return [...new Set(files.filter((file): file is string => file !== undefined))];
}
