import type { BlockType } from '../spec/blocks/index.ts';

// The block catalog (BF-033): what each block is for, when to use or avoid it, its variants, and good and bad
// content, for agents (rendered to markdown in their workspaces) and editors. Props are documented from the schema.

interface Example {
  readonly en: string;
  readonly fr: string;
}

export interface CatalogEntry {
  readonly title: string;
  readonly purpose: string;
  readonly use: readonly string[];
  readonly avoid: readonly string[];
  /** Every variant of the block's schema, described. */
  readonly variants: Readonly<Record<string, string>>;
  readonly good: Example;
  readonly bad: Example;
}

/** Preview image of a block variant (drawn by the block library, BF-034). */
export const thumbnailPath = (type: BlockType, variant: string) => `thumbnails/${type}/${variant}.png`;

export const CATALOG: Readonly<Record<BlockType, CatalogEntry>> = {
  hero: {
    title: 'Hero',
    purpose: 'The first section of every page: what the business is, where, and the main action.',
    use: ['Exactly once per page, first.', 'Title in the business’s own terms; the place in the eyebrow.'],
    avoid: ['Slogans with no information.', 'A second hero further down (use a CTA banner).'],
    variants: {
      split: 'Text beside a photo. Needs an image.',
      centered: 'Centred text, no image: inner pages and businesses without good photos.',
      image_full: 'Full-width photo behind the text. Needs a strong, uncluttered image.',
      minimal: 'A title only: legal and contact pages.',
    },
    good: { en: 'Hair and care in Gustavia', fr: 'Coiffure et soins à Gustavia' },
    bad: { en: 'Welcome to excellence!', fr: 'Bienvenue dans l’excellence !' },
  },
  highlights: {
    title: 'Highlights',
    purpose: 'Three or four strengths at a glance, each backed by a fact.',
    use: ['Concrete, checkable strengths (open 7 days, on the harbour, online booking).'],
    avoid: ['Invented superlatives or numbers.', 'More than six items.'],
    variants: {
      icons: 'An icon and a short title per item.',
      cards: 'Items as cards with a sentence each.',
      inline: 'A single line of short items, for compact pages.',
    },
    good: { en: 'Open 7 days', fr: 'Ouvert 7 jours sur 7' },
    bad: { en: 'Best salon on the island', fr: 'Le meilleur salon de l’île' },
  },
  services: {
    title: 'Services',
    purpose: 'What the business offers, with published prices only.',
    use: [
      'The services as the business names them.',
      'A price only when the business publishes it (a price fact).',
    ],
    avoid: ['Estimated or typical prices.', 'Services the facts do not mention.'],
    variants: {
      grid: 'A grid of short items.',
      list: 'A list with descriptions and prices on the right.',
      cards: 'Cards with an optional photo and action each.',
    },
    good: { en: "Women's cut — €65", fr: 'Coupe femme — 65 €' },
    bad: { en: "Women's cut — from around €50", fr: 'Coupe femme — environ 50 €' },
  },
  menu: {
    title: 'Menu',
    purpose: 'A food or drinks menu from the business’s published menu.',
    use: [
      'Sections and dishes as the menu names them; prices as price facts.',
      'A note for seasonal changes.',
    ],
    avoid: ['Dishes or prices not on the published menu.'],
    variants: {
      columns: 'Sections side by side.',
      list: 'One long list, sections as headings.',
      cards: 'A card per section.',
    },
    good: { en: 'Fresh juice — €7', fr: 'Jus pressé — 7 €' },
    bad: { en: 'Chef’s secret special — ask us!', fr: 'Le plat secret du chef — demandez !' },
  },
  about: {
    title: 'About',
    purpose: 'Who the business is, in two or three short factual paragraphs.',
    use: ['What the facts say: place, specialities, who runs it.'],
    avoid: ['Invented history, years or awards.', 'Marketing filler.'],
    variants: {
      split: 'Text beside a photo.',
      centered: 'Centred text only.',
      story: 'Wider text with a large photo, for businesses with a story the facts tell.',
    },
    good: {
      en: 'On the quai des Indes, we advise homeowners and tradespeople.',
      fr: 'Sur le quai des Indes, nous conseillons particuliers et artisans.',
    },
    bad: { en: 'Founded in 1970 by a passionate family…', fr: 'Fondée en 1970 par une famille passionnée…' },
  },
  gallery: {
    title: 'Gallery',
    purpose: 'Three to twelve photos of the place, the work or the products.',
    use: ['The business’s own or licensed photos, each with a real alt text.'],
    avoid: [
      'Fewer than three good photos (leave the block out).',
      'Stock photos that suggest something untrue.',
    ],
    variants: {
      grid: 'An even grid.',
      masonry: 'Photos of mixed shapes.',
      carousel: 'One photo at a time, for many similar photos.',
    },
    good: { en: 'Alt: The terrace facing the bay', fr: 'Alt : La terrasse face à la baie' },
    bad: { en: 'Alt: image1.jpg', fr: 'Alt : photo' },
  },
  testimonials: {
    title: 'Testimonials',
    purpose: 'Real customer quotes from the fact registry.',
    use: ['Quotes as published, attributed as the policy allows (initials).'],
    avoid: ['Any quote that is not a testimonial fact — never write one.'],
    variants: {
      cards: 'A card per quote with its rating.',
      quotes: 'Large quotes, one or two.',
      carousel: 'One quote at a time.',
    },
    good: {
      en: '“Warm welcome and a perfect cut.” — Claire D.',
      fr: '« Accueil chaleureux et coupe parfaite. » — Claire D.',
    },
    bad: { en: '“Amazing!” — Happy customer', fr: '« Génial ! » — Un client ravi' },
  },
  hours: {
    title: 'Hours',
    purpose: 'Opening hours from the contact facts.',
    use: ['When the opening hours are known.'],
    avoid: ['Guessing hours; without them, invite visitors to call.'],
    variants: { table: 'A table of the week.', compact: 'Days grouped on a few lines.' },
    good: { en: 'Tue–Sat 09:00–18:00', fr: 'Mar.–sam. 9 h–18 h' },
    bad: { en: 'Usually open in the morning', fr: 'En général ouvert le matin' },
  },
  location: {
    title: 'Location',
    purpose: 'Where the business is, with a map and directions.',
    use: ['With an address or coordinates from the facts.'],
    avoid: ['A map without a known location.'],
    variants: {
      map_split: 'Map beside the address.',
      map_full: 'A full-width map.',
      address_only: 'The address and a directions button, no map.',
    },
    good: { en: 'Find us: 12 rue du Port, Gustavia', fr: 'Nous trouver : 12 rue du Port, Gustavia' },
    bad: { en: 'Near the beach', fr: 'Près de la plage' },
  },
  contact: {
    title: 'Contact',
    purpose: 'How to reach the business: the channels it publishes and, optionally, the form.',
    use: ['Only channels present in the contact facts.'],
    avoid: ['Showing a channel the business does not publish.'],
    variants: { split: 'Channels beside the form.', centered: 'Channels centred, form below.' },
    good: { en: 'Contact us', fr: 'Nous contacter' },
    bad: { en: 'Call us 24/7!', fr: 'Appelez-nous 24 h/24 !' },
  },
  cta_banner: {
    title: 'Call-to-action banner',
    purpose: 'A band that asks for one action, near the end of a page.',
    use: ['One clear action: book, call, see the menu.'],
    avoid: ['Several banners on one page.', 'Vague invitations.'],
    variants: { solid: 'On the primary colour.', image: 'Over a photo.', outline: 'Light, with a border.' },
    good: { en: 'Ready for a new look? — Book now', fr: 'Envie d’un nouveau style ? — Réserver' },
    bad: { en: 'Click here', fr: 'Cliquez ici' },
  },
  faq: {
    title: 'FAQ',
    purpose: 'Questions customers ask, answered from the facts.',
    use: ['Answers the facts support; otherwise invite them to ask.'],
    avoid: ['Answers that state new facts (prices, policies) not in the registry.'],
    variants: { accordion: 'Questions that open.', two_column: 'Questions and answers side by side.' },
    good: {
      en: 'Do you cut keys? — Yes, on site, during opening hours.',
      fr: 'Faites-vous les clés ? — Oui, sur place, aux heures d’ouverture.',
    },
    bad: { en: 'Is parking free? — Yes, always.', fr: 'Le parking est-il gratuit ? — Oui, toujours.' },
  },
  team: {
    title: 'Team',
    purpose: 'People the business presents publicly.',
    use: ['Team-member facts only, with their published role.'],
    avoid: ['Inventing people or roles.'],
    variants: { grid: 'A grid of portraits.', list: 'A list with roles.' },
    good: { en: 'Léa M. — Manager', fr: 'Léa M. — Gérante' },
    bad: { en: 'Our expert team of 20', fr: 'Notre équipe de 20 experts' },
  },
  booking: {
    title: 'Booking',
    purpose: 'Sends visitors to the business’s existing booking page.',
    use: ['When the facts give a booking URL (known provider or own domain).'],
    avoid: ['Any booking link the facts do not hold.'],
    variants: {
      link: 'A button to the booking page.',
      embed: 'The booking page embedded, where the provider allows it.',
    },
    good: { en: 'Book your appointment — Book online', fr: 'Prendre rendez-vous — Réserver en ligne' },
    bad: { en: 'Book via this link: …', fr: 'Réservez via ce lien : …' },
  },
  social_links: {
    title: 'Social links',
    purpose: 'Links to the business’s own social profiles.',
    use: ['When the contact facts list profiles.'],
    avoid: ['Profiles of other businesses or people.'],
    variants: { icons: 'Network icons.', buttons: 'Labelled buttons.' },
    good: { en: 'Follow us', fr: 'Suivez-nous' },
    bad: { en: 'Follow our partners', fr: 'Suivez nos partenaires' },
  },
  rich_text: {
    title: 'Rich text',
    purpose: 'Longer text such as legal notices, in a small markdown subset.',
    use: ['Paragraphs, **bold**, *italic*, "- " lists, links to the site’s own pages as [label](page:<id>).'],
    avoid: ['HTML, images or links to other sites.'],
    variants: { narrow: 'A reading column.', wide: 'The full content width.' },
    good: { en: 'See the [home](page:home) page.', fr: 'Voir la page d’[accueil](page:home).' },
    bad: { en: 'See <a href="https://…">here</a>', fr: 'Voir <a href="https://…">ici</a>' },
  },
};
