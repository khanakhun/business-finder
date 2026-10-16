import { z } from 'zod';
import { BlockSchema } from './blocks/index.ts';
import { LIMITS } from './limits.ts';
import { ElementIdSchema, localized, PageIdSchema } from './localized.ts';

export const PageSchema = z
  .object({
    id: PageIdSchema,
    slug: z
      .string()
      .regex(/^$|^[a-z0-9]+(-[a-z0-9]+)*$/)
      .describe('The URL path segment: "" for the home page, else kebab-case (e.g. "our-menu"). Unique.'),
    title: localized(LIMITS.pageTitle.max, 'The page name, e.g. "Menu".'),
    seo: z
      .object({
        title: localized(
          LIMITS.seoTitle.max,
          'The browser/search title (20–60 characters), e.g. "Salon Lumière – Hair salon in Gustavia".',
        ),
        description: localized(LIMITS.seoDescription.max, 'The search snippet (120–160 characters).'),
        ogImageAssetId: ElementIdSchema.optional(),
      })
      .strict(),
    blocks: z.array(BlockSchema).min(1).max(20),
  })
  .strict();
export type Page = z.infer<typeof PageSchema>;
