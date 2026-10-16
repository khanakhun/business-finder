import { z } from 'zod';

// Curated font pairs (BF-033): the only typography a site can use. Open licenses only; the renderer (BF-034) self-
// hosts them. Each pair names its fallbacks so text renders before the fonts load.

export interface FontPair {
  readonly id: string;
  readonly heading: { readonly family: string; readonly fallback: string };
  readonly body: { readonly family: string; readonly fallback: string };
  readonly license: 'OFL-1.1' | 'Apache-2.0';
  /** Styles the pair suits (agents prefer these). */
  readonly suits: readonly ('luxe' | 'modern' | 'warm' | 'minimal' | 'coastal')[];
}

const serif = 'Georgia, "Times New Roman", serif';
const sans = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export const FONT_PAIRS = [
  {
    id: 'playfair-inter',
    heading: { family: 'Playfair Display', fallback: serif },
    body: { family: 'Inter', fallback: sans },
    license: 'OFL-1.1',
    suits: ['luxe', 'coastal'],
  },
  {
    id: 'cormorant-montserrat',
    heading: { family: 'Cormorant Garamond', fallback: serif },
    body: { family: 'Montserrat', fallback: sans },
    license: 'OFL-1.1',
    suits: ['luxe'],
  },
  {
    id: 'dmserif-dmsans',
    heading: { family: 'DM Serif Display', fallback: serif },
    body: { family: 'DM Sans', fallback: sans },
    license: 'OFL-1.1',
    suits: ['warm', 'modern'],
  },
  {
    id: 'fraunces-worksans',
    heading: { family: 'Fraunces', fallback: serif },
    body: { family: 'Work Sans', fallback: sans },
    license: 'OFL-1.1',
    suits: ['warm'],
  },
  {
    id: 'spacegrotesk-inter',
    heading: { family: 'Space Grotesk', fallback: sans },
    body: { family: 'Inter', fallback: sans },
    license: 'OFL-1.1',
    suits: ['modern', 'minimal'],
  },
  {
    id: 'manrope-manrope',
    heading: { family: 'Manrope', fallback: sans },
    body: { family: 'Manrope', fallback: sans },
    license: 'OFL-1.1',
    suits: ['minimal', 'modern'],
  },
  {
    id: 'josefin-lato',
    heading: { family: 'Josefin Sans', fallback: sans },
    body: { family: 'Lato', fallback: sans },
    license: 'OFL-1.1',
    suits: ['coastal', 'minimal'],
  },
] as const satisfies readonly FontPair[];

export const FONT_PAIR_IDS = FONT_PAIRS.map((pair) => pair.id) as [
  (typeof FONT_PAIRS)[number]['id'],
  ...(typeof FONT_PAIRS)[number]['id'][],
];
export const FontPairIdSchema = z
  .enum(FONT_PAIR_IDS)
  .describe(
    'A curated heading/body font pair. Prefer one that suits the theme style (see the block catalog).',
  );
export type FontPairId = z.infer<typeof FontPairIdSchema>;
