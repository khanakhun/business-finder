import { z } from 'zod';
import { CtaActionSchema } from '../cta.ts';
import { LIMITS } from '../limits.ts';
import { FactIdSchema, localized } from '../localized.ts';
import { AssetRefSchema, block, heading } from './common.ts';

export const ICONS = [
  'star',
  'leaf',
  'clock',
  'map_pin',
  'phone',
  'sparkles',
  'heart',
  'shield',
  'sun',
  'waves',
  'utensils',
  'coffee',
  'scissors',
  'wrench',
  'hammer',
  'home',
  'key',
  'calendar',
  'award',
  'users',
  'wifi',
  'car',
  'truck',
  'gift',
] as const;

export const HeroBlockSchema = block(
  'hero',
  ['split', 'centered', 'image_full', 'minimal'],
  {
    eyebrow: localized(
      LIMITS.eyebrow.max,
      'A short line above the title, e.g. the place: "Gustavia · St Barth".',
    ).optional(),
    title: localized(
      LIMITS.heroTitle.max,
      'The page headline: what the business is, in its own terms. Up to 60 characters.',
    ),
    subtitle: localized(
      LIMITS.heroSubtitle.max,
      'One sentence on why customers come (40–160 characters).',
    ).optional(),
    primaryCta: CtaActionSchema.optional(),
    secondaryCta: CtaActionSchema.optional(),
    imageAssetId: AssetRefSchema.optional().describe(
      'The main photo (required by the `split` and `image_full` variants).',
    ),
  },
  'The first section of a page: headline, a sentence and the main action. Exactly one per page, first.',
);

export const HighlightsBlockSchema = block(
  'highlights',
  ['icons', 'cards', 'inline'],
  {
    heading: heading().optional(),
    items: z
      .array(
        z
          .object({
            icon: z.enum(ICONS),
            title: localized(LIMITS.itemTitle.max, 'A short strength, e.g. "Open 7 days".'),
            text: localized(LIMITS.itemText.max, 'One sentence backing it.').optional(),
            factIds: z.array(FactIdSchema).max(5).optional().describe('The facts this highlight states.'),
          })
          .strict(),
      )
      .min(2)
      .max(6),
  },
  'Three or four strengths of the business at a glance. Only true, fact-backed claims.',
);

export const CtaBannerBlockSchema = block(
  'cta_banner',
  ['solid', 'image', 'outline'],
  {
    title: localized(LIMITS.heading.max, 'An invitation, e.g. "Ready for your next cut?".'),
    text: localized(LIMITS.intro.max, 'One supporting sentence.').optional(),
    cta: CtaActionSchema,
    imageAssetId: AssetRefSchema.optional().describe('Background photo for the `image` variant.'),
  },
  'A band that asks for one action; typically near the end of a page.',
);
