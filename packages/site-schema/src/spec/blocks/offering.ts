import { z } from 'zod';
import { CtaActionSchema } from '../cta.ts';
import { LIMITS } from '../limits.ts';
import { localized } from '../localized.ts';
import { AssetRefSchema, block, heading, intro, PriceSchema } from './common.ts';

export const ServicesBlockSchema = block(
  'services',
  ['grid', 'list', 'cards'],
  {
    heading: heading(),
    intro: intro().optional(),
    items: z
      .array(
        z
          .object({
            title: localized(LIMITS.itemTitle.max, 'The service as the business names it.'),
            description: localized(
              LIMITS.itemText.max,
              'What it includes, in one or two sentences.',
            ).optional(),
            price: PriceSchema.optional(),
            imageAssetId: AssetRefSchema.optional(),
            cta: CtaActionSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  },
  'What the business offers. Prices only when the business publishes them (price facts).',
);

export const MENU_TAGS = ['vegetarian', 'vegan', 'gluten_free', 'spicy', 'house_special', 'local'] as const;

export const MenuBlockSchema = block(
  'menu',
  ['columns', 'list', 'cards'],
  {
    heading: heading(),
    intro: intro().optional(),
    sections: z
      .array(
        z
          .object({
            title: localized(LIMITS.itemTitle.max, 'A menu section, e.g. "Starters".'),
            items: z
              .array(
                z
                  .object({
                    name: localized(LIMITS.itemTitle.max, 'The dish as the menu names it.'),
                    description: localized(LIMITS.itemText.max, 'Its ingredients or style.').optional(),
                    price: PriceSchema.optional(),
                    tags: z.array(z.enum(MENU_TAGS)).max(4).optional(),
                  })
                  .strict(),
              )
              .min(1)
              .max(30),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    note: localized(LIMITS.note.max, 'E.g. "Menu changes with the season".').optional(),
  },
  'A food or drinks menu from the business’s published menu (prices are price facts).',
);

export const BookingBlockSchema = block(
  'booking',
  ['link', 'embed'],
  {
    heading: heading('E.g. "Book your appointment".'),
    intro: intro().optional(),
    label: localized(LIMITS.ctaLabel.max, 'The button, e.g. "Book online".'),
  },
  "Sends visitors to the business's existing booking page (`contact.bookingUrl`). Requires a booking URL.",
);
