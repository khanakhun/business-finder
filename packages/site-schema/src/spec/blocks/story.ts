import { z } from 'zod';
import { LIMITS } from '../limits.ts';
import { FactIdSchema, localized } from '../localized.ts';
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
    assetIds: z.array(AssetRefSchema).min(3).max(12),
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
            author: z.string().trim().min(1).max(60).describe('As published, e.g. "Marie L.".'),
            source: z.enum(['google', 'tripadvisor', 'facebook', 'direct']).optional(),
            rating: z.number().int().min(1).max(5).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(6),
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
            name: z.string().trim().min(1).max(60),
            role: localized(LIMITS.itemTitle.max, 'E.g. "Head chef".').optional(),
            photoAssetId: AssetRefSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  },
  'People the business presents publicly (team facts only).',
);
