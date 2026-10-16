import { z } from 'zod';
import { FontPairIdSchema } from '../fonts.ts';

export const THEME_STYLES = ['luxe', 'modern', 'warm', 'minimal', 'coastal'] as const;

const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .describe('A colour as #rrggbb.');

/** Colours of the site; text must keep WCAG AA contrast on background and surface (the validator checks it). */
export const PaletteSchema = z
  .object({
    primary: hex.describe(
      'Brand colour: buttons, links and highlights (#rrggbb). Needs 3:1 contrast on the background.',
    ),
    secondary: hex.optional().describe('Optional second brand colour for accents in large areas (#rrggbb).'),
    accent: hex.describe(
      'Small accents: icons, rules, badges (#rrggbb). Needs 3:1 contrast on the background.',
    ),
    background: hex.describe(
      'Page background (#rrggbb). Usually very light (or very dark for a dark theme).',
    ),
    surface: hex.describe('Cards and panels on the background (#rrggbb).'),
    text: hex.describe('Body text (#rrggbb). Needs 4.5:1 contrast on the background and on the surface.'),
    mutedText: hex.describe(
      'Secondary text such as captions (#rrggbb). Needs 4.5:1 contrast on the background.',
    ),
  })
  .strict()
  .describe('The site palette. Pick colours from the business (logo, photos) and keep text readable.');
export type Palette = z.infer<typeof PaletteSchema>;

export const ThemeSchema = z
  .object({
    style: z
      .enum(THEME_STYLES)
      .describe(
        'Overall design family: luxe (refined, serif, generous space), modern (clean, geometric), warm (friendly, ' +
          'earthy), minimal (sparse, typographic), coastal (light, airy, sea tones).',
      ),
    palette: PaletteSchema,
    typography: z.object({ pairId: FontPairIdSchema }).strict(),
    radius: z
      .enum(['none', 'sm', 'md', 'lg', 'full'])
      .describe('Corner rounding of buttons, cards and images.'),
    density: z.enum(['compact', 'comfortable', 'airy']).describe('Spacing between and inside sections.'),
    imageTreatment: z.enum(['plain', 'rounded', 'framed']).describe('How photos are shown.'),
  })
  .strict()
  .describe('Visual theme: one style family, a palette, a font pair and a few tokens.');
export type Theme = z.infer<typeof ThemeSchema>;
