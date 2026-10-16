import { z } from 'zod';
import { AssetSchema } from './assets.ts';
import { ContactSchema } from './contact.ts';
import { LayoutSchema, NavigationSchema } from './layout.ts';
import { LIMITS } from './limits.ts';
import { FactIdSchema, localized, SiteLocaleSchema } from './localized.ts';
import { PageSchema } from './page.ts';
import { ThemeSchema } from './theme.ts';

export const SITE_SCHEMA_VERSION = 1 as const;

/**
 * SiteSpec v1 (BF-033): a local business's website as a document. Every engine outputs one; the block library renders
 * it; editors change it through operations. Facts (contact, prices, testimonials, team) come from the fact registry.
 */
export const SiteSpecSchema = z
  .object({
    schemaVersion: z.literal(SITE_SCHEMA_VERSION),
    locales: z
      .array(SiteLocaleSchema)
      .min(1)
      .max(4)
      .describe('The site languages, the default one first by convention.'),
    defaultLocale: SiteLocaleSchema.describe('One of `locales`: served at the site root.'),
    brand: z
      .object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(LIMITS.brandName.max)
          .describe('The business name exactly as it is known.'),
        factId: FactIdSchema.optional(),
      })
      .strict(),
    theme: ThemeSchema,
    contact: ContactSchema,
    layout: LayoutSchema,
    navigation: NavigationSchema,
    pages: z.array(PageSchema).min(1).max(8),
    assets: z.array(AssetSchema).max(120),
    seo: z
      .object({
        title: localized(LIMITS.siteTitle.max, 'The site title, e.g. "Café Saint-Jean".'),
        description: localized(
          LIMITS.siteDescription.max,
          'What the business is and where (120–160 characters).',
        ),
      })
      .strict(),
    settings: z
      .object({
        noindex: z.boolean().describe('Keep search engines out (true for previews).'),
        previewBanner: z.boolean().describe('Show the "concept preview" banner (true for previews).'),
        analytics: z.enum(['cookieless', 'none']),
        contactForm: z.object({ enabled: z.boolean() }).strict(),
      })
      .strict(),
  })
  .strict()
  .meta({ id: 'SiteSpec', title: 'SiteSpec v1' });
export type SiteSpec = z.infer<typeof SiteSpecSchema>;
