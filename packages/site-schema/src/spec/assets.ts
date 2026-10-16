import { z } from 'zod';
import { LIMITS } from './limits.ts';
import { ElementIdSchema, HttpsUrlSchema, localized, plainText } from './localized.ts';

/**
 * Where an image may come from. `owner_site`: the business's own website; `stock`: a licensed stock library;
 * `ai_generated`; `uploaded` by the agency or the business. Provider images (maps, review sites) are never allowed.
 */
export const ASSET_LICENSES = ['owner_site', 'stock', 'ai_generated', 'uploaded'] as const;

export const AssetSchema = z
  .object({
    id: ElementIdSchema,
    kind: z.enum(['image', 'logo', 'icon']).describe('A photo, the logo, or a small icon.'),
    url: HttpsUrlSchema.describe('The copy on our storage/CDN host (never a third-party URL).'),
    width: z.number().int().min(1).max(10_000).describe('Width in pixels.'),
    height: z.number().int().min(1).max(10_000).describe('Height in pixels.'),
    alt: localized(
      LIMITS.alt.max,
      'What the image shows, for screen readers, e.g. "Terrace facing the bay at sunset".',
    ),
    license: z
      .enum(ASSET_LICENSES)
      .describe(
        "owner_site: from the business's own website; stock: a licensed library; ai_generated; uploaded by the agency or the business.",
      ),
    attribution: plainText(200, 'Credit line when the license requires one.').optional(),
    focalPoint: z
      .object({
        x: z.number().min(0).max(1).describe('From the left, 0–1.'),
        y: z.number().min(0).max(1).describe('From the top, 0–1.'),
      })
      .strict()
      .optional()
      .describe('Point to keep in view when cropping (0–1 from the top left).'),
    dominantColors: z
      .array(z.string().regex(/^#[0-9a-fA-F]{6}$/))
      .max(5)
      .optional()
      .describe('Its main colours (palette hints).'),
  })
  .strict()
  .describe('An image the site uses.')
  .meta({ id: 'Asset' });
export type Asset = z.infer<typeof AssetSchema>;
