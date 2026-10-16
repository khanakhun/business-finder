import { z } from 'zod';
import { LIMITS } from '../limits.ts';
import { FactIdSchema, localized, plainText } from '../localized.ts';
import { AssetRefSchema, block, heading } from './common.ts';

export const AboutBlockSchema = block(
  'about',
  ['split', 'centered', 'story'],
  {
    heading: heading('E.g. "About us".'),
    body: localized(
      LIMITS.body.max,
      'Two or three short paragraphs (blank line between) on the business. Facts only.',
    ),
    imageAssetId: AssetRefSchema.optional(),
    factIds: z
      .array(FactIdSchema)
      .max(20)
      .optional()
      .describe('The facts the text states (years, origins…).'),
  },
  'Who the business is. Neutral and factual; no invented history.',
);

export const GalleryBlockSchema = block(
  'gallery',
  ['grid', 'masonry', 'carousel'],
  {
    heading: heading().optional(),
    assetIds: z.array(AssetRefSchema).min(3).max(12).describe('Three to twelve image assets.'),
  },
  'Three to twelve photos of the place, the work or the products.',
);

export const TestimonialsBlockSchema = block(
  'testimonials',
  ['cards', 'quotes', 'carousel'],
  {
    heading: heading().optional(),
    items: z
      .array(
        z
          .object({
            factId: FactIdSchema.describe(
              'The testimonial fact quoted. Required: never write a testimonial.',
            ),
            quote: localized(
              LIMITS.quote.max,
              'The quote as published (translated faithfully for other locales).',
            ),
            author: plainText(
              60,
              'As the attribution policy allows: initials, e.g. "Marie L.", or left out.',
            ).optional(),
            source: z
              .enum(['google', 'tripadvisor', 'facebook', 'direct'])
              .optional()
              .describe('Where it was published.'),
            rating: z.number().int().min(1).max(5).optional().describe('Its star rating, as published.'),
          })
          .strict(),
      )
      .min(1)
      .max(6)
      .describe('The quotes, one to six.'),
  },
  'Real customer quotes from the fact registry only. Never fabricate a testimonial.',
);

export const TeamBlockSchema = block(
  'team',
  ['grid', 'list'],
  {
    heading: heading('E.g. "The team".').optional(),
    members: z
      .array(
        z
          .object({
            factId: FactIdSchema.describe('The team-member fact. Required.'),
            name: plainText(60, 'The name as the business presents it, e.g. "Léa M.".'),
            role: localized(LIMITS.itemTitle.max, 'E.g. "Head chef".').optional(),
            photoAssetId: AssetRefSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(12)
      .describe('The people, as the business presents them.'),
  },
  'People the business presents publicly (team facts only).',
);
