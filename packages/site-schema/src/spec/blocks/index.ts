import { z } from 'zod';
import { CtaBannerBlockSchema, HeroBlockSchema, HighlightsBlockSchema } from './marketing.ts';
import { BookingBlockSchema, MenuBlockSchema, ServicesBlockSchema } from './offering.ts';
import {
  ContactBlockSchema,
  FaqBlockSchema,
  HoursBlockSchema,
  LocationBlockSchema,
  RichTextBlockSchema,
  SocialLinksBlockSchema,
} from './practical.ts';
import { AboutBlockSchema, GalleryBlockSchema, TeamBlockSchema, TestimonialsBlockSchema } from './story.ts';

/** Every block type, keyed by its `type` (Registry). Adding a block: see the package README. */
export const BLOCK_SCHEMAS = {
  hero: HeroBlockSchema,
  highlights: HighlightsBlockSchema,
  services: ServicesBlockSchema,
  menu: MenuBlockSchema,
  about: AboutBlockSchema,
  gallery: GalleryBlockSchema,
  testimonials: TestimonialsBlockSchema,
  hours: HoursBlockSchema,
  location: LocationBlockSchema,
  contact: ContactBlockSchema,
  cta_banner: CtaBannerBlockSchema,
  faq: FaqBlockSchema,
  team: TeamBlockSchema,
  booking: BookingBlockSchema,
  social_links: SocialLinksBlockSchema,
  rich_text: RichTextBlockSchema,
} as const;

export type BlockType = keyof typeof BLOCK_SCHEMAS;
export const BLOCK_TYPES = Object.keys(BLOCK_SCHEMAS) as [BlockType, ...BlockType[]];

export const BlockSchema = z
  .discriminatedUnion('type', [
    HeroBlockSchema,
    HighlightsBlockSchema,
    ServicesBlockSchema,
    MenuBlockSchema,
    AboutBlockSchema,
    GalleryBlockSchema,
    TestimonialsBlockSchema,
    HoursBlockSchema,
    LocationBlockSchema,
    ContactBlockSchema,
    CtaBannerBlockSchema,
    FaqBlockSchema,
    TeamBlockSchema,
    BookingBlockSchema,
    SocialLinksBlockSchema,
    RichTextBlockSchema,
  ])
  .describe('A section of a page, discriminated by `type`.');
export type Block = z.infer<typeof BlockSchema>;
export type BlockOf<T extends BlockType> = Extract<Block, { type: T }>;

/** A block type's variants (from its schema). */
export function blockVariants(type: BlockType): readonly string[] {
  return BLOCK_SCHEMAS[type].shape.variant.options;
}

export { ICONS } from './marketing.ts';
export { MENU_TAGS } from './offering.ts';
