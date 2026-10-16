import { z } from 'zod';
import { CtaActionSchema } from './cta.ts';
import { LIMITS } from './limits.ts';
import { ElementIdSchema, localized, PageIdSchema } from './localized.ts';

export const LayoutSchema = z
  .object({
    header: z
      .object({
        variant: z
          .enum(['simple', 'centered', 'transparent'])
          .describe('`transparent` sits over the first hero image.'),
        logoAssetId: ElementIdSchema.optional().describe(
          'A `logo` asset; without one the brand name is shown.',
        ),
        showCta: z.boolean().describe('Show a button in the header.'),
        cta: CtaActionSchema.optional().describe('The header button (when `showCta`).'),
      })
      .strict()
      .describe('The header.'),
    footer: z
      .object({
        variant: z.enum(['simple', 'columns']).describe('One line, or columns (contact, hours, menu).'),
        showSocials: z.boolean().describe('Show the social profiles (needs contact.socials).'),
        showHours: z.boolean().describe('Show the opening hours (needs contact.hours).'),
        tagline: localized(LIMITS.tagline.max, 'A line under the brand name.').optional(),
      })
      .strict()
      .describe('The footer.'),
  })
  .strict()
  .describe('Header and footer.')
  .meta({ id: 'Layout' });
export type Layout = z.infer<typeof LayoutSchema>;

export const NavigationSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            pageId: PageIdSchema.describe('The page the item opens.'),
            label: localized(LIMITS.navLabel.max, 'A one- or two-word menu label, e.g. "Services".'),
          })
          .strict(),
      )
      .max(7)
      .describe('The menu items, in order.'),
  })
  .strict()
  .describe('The main menu: up to 7 pages, in order.');
export type Navigation = z.infer<typeof NavigationSchema>;
