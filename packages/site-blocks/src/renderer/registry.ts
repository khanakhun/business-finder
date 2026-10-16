import type { BlockType } from '@bf/site-schema';
import { About } from '../blocks/about.tsx';
import { Booking } from '../blocks/booking.tsx';
import { Contact } from '../blocks/contact.tsx';
import { CtaBanner } from '../blocks/cta-banner.tsx';
import { Faq } from '../blocks/faq.tsx';
import { Gallery } from '../blocks/gallery.tsx';
import { Hero } from '../blocks/hero.tsx';
import { Highlights } from '../blocks/highlights.tsx';
import { Hours } from '../blocks/hours.tsx';
import { Location } from '../blocks/location.tsx';
import { Menu } from '../blocks/menu.tsx';
import { RichText } from '../blocks/rich-text.tsx';
import { Services } from '../blocks/services.tsx';
import { SocialLinks } from '../blocks/social-links.tsx';
import { Team } from '../blocks/team.tsx';
import { Testimonials } from '../blocks/testimonials.tsx';
import type { BlockComponent } from './types.ts';

/** Block type → component (Registry). The type requires one for every block type of the schema. */
export const BLOCK_COMPONENTS: { readonly [T in BlockType]: BlockComponent<T> } = {
  hero: Hero,
  highlights: Highlights,
  services: Services,
  menu: Menu,
  about: About,
  gallery: Gallery,
  testimonials: Testimonials,
  hours: Hours,
  location: Location,
  contact: Contact,
  cta_banner: CtaBanner,
  faq: Faq,
  team: Team,
  booking: Booking,
  social_links: SocialLinks,
  rich_text: RichText,
};
