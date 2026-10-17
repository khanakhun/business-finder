import { z } from 'zod';
import { BlockSchema } from './blocks/index.ts';
import { LIMITS } from './limits.ts';
import { ElementIdSchema, localized, PageIdSchema, SITE_LOCALES } from './localized.ts';

/** Slugs the renderer's routes use (a locale prefix, our paths, a preview's claim, opt-out and privacy pages). */
export const RESERVED_SLUGS: readonly string[] = [
  ...SITE_LOCALES,
  'api',
  'assets',
  'static',
  '_next',
  'admin',
  'preview',
  'health',
  'claim',
  'opt-out',
  'privacy',
  // BF-062: a live site's legal notice.
  'legal',
];

export const PageSchema = z
  .object({
    id: PageIdSchema.describe('The page id (stable: links and the menu refer to it).'),
    slug: z
      .string()
      .regex(/^$|^[a-z0-9]+(-[a-z0-9]+)*$/)
      .refine((slug) => !RESERVED_SLUGS.includes(slug), {
        message: 'This slug is reserved (a locale or one of our paths)',
      })
      .describe('The URL path segment: "" for the home page, else kebab-case (e.g. "our-menu"). Unique.'),
    title: localized(LIMITS.pageTitle.max, 'The page name, e.g. "Menu".'),
    seo: z
      .object({
        title: localized(
          LIMITS.seoTitle.max,
          'The browser/search title (20–60 characters), e.g. "Salon Lumière – Hair salon in Gustavia".',
        ),
        description: localized(LIMITS.seoDescription.max, 'The search snippet (120–160 characters).'),
        ogImageAssetId: ElementIdSchema.optional().describe('The image shown when the page is shared.'),
      })
      .strict()
      .describe('Search and sharing texts of the page.'),
    blocks: z
      .array(BlockSchema)
      .min(1)
      .max(20)
      .describe('The sections of the page, in order; the first is the hero.'),
  })
  .strict()
  .meta({ id: 'Page' });
export type Page = z.infer<typeof PageSchema>;
