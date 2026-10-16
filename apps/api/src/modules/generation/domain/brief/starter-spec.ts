import type { GenerationBrief, RegistryFact } from '@bf/contracts';
import {
  type Asset,
  contrastRatio,
  FONT_PAIRS,
  hostAllowed,
  isSocialProfile,
  KNOWN_BOOKING_HOSTS,
  LIMITS,
  type SiteSpec,
  SOCIAL_NETWORKS,
  suggestColor,
} from '@bf/site-schema';

// The starter spec (BF-040): a valid SiteSpec built from the brief's page plan and the display facts only. Engines
// refine it; the blocks engine can fill it directly. Copy is neutral and digit-free where no fact backs it, and every
// such placeholder is listed in `annotations` (`TODO-COPY`, never rendered). Blocks whose facts are missing are left
// out rather than filled.

type Localized = Record<string, string>;
type Block = SiteSpec['pages'][number]['blocks'][number];
type Cta = NonNullable<SiteSpec['layout']['header']['cta']>;
type Plan = GenerationBrief['pagePlan'];

export interface StarterSpec {
  readonly spec: SiteSpec;
  /** JSON pointers of placeholder copy engines should rewrite (`TODO-COPY`). */
  readonly annotations: Readonly<Record<string, 'TODO-COPY'>>;
}

const COPY = {
  page: {
    home: ['Accueil', 'Home'],
    menu: ['La carte', 'Menu'],
    services: ['Services', 'Services'],
    products: ['Produits', 'Products'],
    about: ['À propos', 'About'],
    contact: ['Contact', 'Contact'],
    booking: ['Réserver', 'Book'],
    gallery: ['Galerie', 'Gallery'],
  },
  heading: {
    services: ['Nos services', 'Our services'],
    products: ['Produits et services', 'Products and services'],
    menu: ['La carte', 'Our menu'],
    about: ['À propos', 'About us'],
    testimonials: ['Ils en parlent', 'What clients say'],
    team: ['L’équipe', 'The team'],
    gallery: ['En images', 'Gallery'],
    hours: ['Horaires', 'Opening hours'],
    location: ['Nous trouver', 'Find us'],
    contact: ['Nous contacter', 'Contact us'],
    booking: ['Réserver', 'Book'],
    faq: ['Questions fréquentes', 'Questions'],
    highlights: ['En bref', 'At a glance'],
  },
  cta: {
    call: ['Appeler', 'Call us'],
    email: ['Écrire', 'Email us'],
    whatsapp: ['WhatsApp', 'WhatsApp'],
    booking: ['Réserver', 'Book'],
    page: ['Nous contacter', 'Contact us'],
  },
  ctaBanner: ['Une question ? Parlons-en.', 'Questions? Get in touch.'],
  bookingLabel: ['Réserver en ligne', 'Book online'],
  menuSection: ['La carte', 'Menu'],
  faq: {
    area_served: ['Où intervenez-vous ?', 'Where do you work?'],
    payment_method: ['Quels moyens de paiement acceptez-vous ?', 'Which payment methods do you accept?'],
    language_spoken: ['Quelles langues parlez-vous ?', 'Which languages do you speak?'],
  },
} as const;

const PALETTES = {
  luxe: { background: '#fbf8f3', surface: '#ffffff', text: '#2b2420', mutedText: '#6b5f55' },
  modern: { background: '#f7f9fb', surface: '#ffffff', text: '#1b2733', mutedText: '#55636f' },
  warm: { background: '#fff9f0', surface: '#ffffff', text: '#2a1d14', mutedText: '#6a574a' },
  minimal: { background: '#ffffff', surface: '#f6f6f4', text: '#1f2328', mutedText: '#59606a' },
  coastal: { background: '#f5fafb', surface: '#ffffff', text: '#12313a', mutedText: '#4f666d' },
} as const;
const THEME = {
  luxe: { radius: 'sm', imageTreatment: 'framed' },
  modern: { radius: 'md', imageTreatment: 'rounded' },
  warm: { radius: 'md', imageTreatment: 'rounded' },
  minimal: { radius: 'none', imageTreatment: 'plain' },
  coastal: { radius: 'lg', imageTreatment: 'rounded' },
} as const;

const ICON_BY_KIND: Readonly<Record<string, string>> = {
  service: 'star',
  amenity: 'sparkles',
  award: 'award',
  year_founded: 'calendar',
  language_spoken: 'users',
  area_served: 'map_pin',
  payment_method: 'shield',
};

const E164 = /^\+[1-9]\d{6,14}$/;
const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
const norm = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

class Builder {
  readonly annotations: Record<string, 'TODO-COPY'> = {};
  private readonly display: RegistryFact[];
  private readonly used = new Set<string>();

  constructor(
    readonly brief: GenerationBrief,
    facts: readonly RegistryFact[],
    private readonly candidates: readonly Asset[],
    readonly countryCode: string,
  ) {
    this.display = facts.filter((fact) => fact.usage === 'display');
  }

  get locales() {
    return this.brief.locales.available;
  }

  /** A text in every locale: French where the site speaks it, English elsewhere. */
  copy([fr, en]: readonly [string, string] | readonly string[]): Localized {
    return Object.fromEntries(
      this.locales.map((locale) => [locale, locale === 'fr' ? (fr as string) : (en as string)]),
    );
  }

  /** The same words in every locale (a value as the business writes it; engines translate). */
  same(text: string, max: number): Localized {
    return Object.fromEntries(this.locales.map((locale) => [locale, clip(text, max)]));
  }

  todo(pointer: string) {
    this.annotations[pointer] = 'TODO-COPY';
  }

  facts(kind: RegistryFact['kind']) {
    return this.display.filter((fact) => fact.kind === kind);
  }

  text(fact: RegistryFact): string {
    return typeof fact.value === 'string' ? fact.value : '';
  }

  image(index: number, large = false): Asset | undefined {
    const images = this.candidates.filter(
      (asset) => asset.kind === 'image' && (!large || asset.width >= 1200),
    );
    const asset = images[index];
    if (asset) this.used.add(asset.id);
    return asset;
  }

  logo(): Asset | undefined {
    const logo = this.candidates.find((asset) => asset.kind === 'logo');
    if (logo) this.used.add(logo.id);
    return logo;
  }

  /** The assets used, their alt text in exactly the site's locales. */
  assets(): Asset[] {
    return this.candidates
      .filter((asset) => this.used.has(asset.id))
      .map((asset) => {
        const alts = asset.alt as Localized;
        const any = Object.values(alts).find(Boolean) ?? this.brief.identity.name;
        return {
          ...asset,
          alt: Object.fromEntries(this.locales.map((locale) => [locale, alts[locale] ?? any])),
        } as Asset;
      });
  }
}

function contactOf(b: Builder): SiteSpec['contact'] {
  const contact: SiteSpec['contact'] = {};
  const phone = b.facts('phone').find((fact) => E164.test(b.text(fact)));
  if (phone) contact.phone = { value: b.text(phone), factId: phone.id };
  const whatsapp = b.facts('whatsapp').find((fact) => E164.test(b.text(fact)));
  if (whatsapp) contact.whatsapp = { value: b.text(whatsapp), factId: whatsapp.id };
  const email = b.facts('email')[0];
  if (email) contact.email = { value: b.text(email), factId: email.id };
  const address = b.facts('address')[0];
  const locality = b.brief.identity.locality;
  // The address's parts must be words of the address fact: without the locality in it, it is left out.
  if (address && locality && ` ${norm(b.text(address))} `.includes(` ${norm(locality)} `))
    contact.address = {
      formatted: clip(b.text(address), 300),
      locality,
      country: b.countryCode,
      factId: address.id,
    } as NonNullable<SiteSpec['contact']['address']>;
  const geo = b.facts('geo')[0];
  if (geo && typeof geo.value === 'object' && geo.value && 'lat' in geo.value)
    contact.geo = { lat: geo.value.lat, lng: geo.value.lng, factId: geo.id } as NonNullable<
      SiteSpec['contact']['geo']
    >;
  const hours = b.facts('hours')[0];
  if (hours?.kind === 'hours') {
    const entries = hours.value.weekly;
    const weekly = Object.fromEntries(
      (['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const).map((day) => [
        day,
        entries
          .filter((entry) => entry.day === day)
          .slice(0, 3)
          .map((entry) => ({ open: entry.opens, close: entry.closes })),
      ]),
    );
    contact.hours = { weekly, factId: hours.id } as NonNullable<SiteSpec['contact']['hours']>;
  }
  const socials = b
    .facts('social')
    .flatMap((fact) => {
      const value = fact.value as { network: string; url: string };
      const network = value.network.toLowerCase() === 'twitter' ? 'x' : value.network.toLowerCase();
      if (!(SOCIAL_NETWORKS as readonly string[]).includes(network) || !value.url.startsWith('https://'))
        return [];
      if (!isSocialProfile(network, value.url)) return [];
      return [{ network, url: value.url, factId: fact.id }];
    })
    .slice(0, 8);
  if (socials.length > 0) contact.socials = socials as NonNullable<SiteSpec['contact']['socials']>;
  const booking = b.facts('booking_provider').find((fact) => {
    const url = (fact.value as { url: string }).url;
    return url.startsWith('https://') && hostAllowed(url, KNOWN_BOOKING_HOSTS);
  });
  if (booking) contact.bookingUrl = { value: (booking.value as { url: string }).url, factId: booking.id };
  return contact;
}

function primaryCta(b: Builder, contact: SiteSpec['contact'], contactPage: boolean): Cta | undefined {
  if (contact.bookingUrl) return { kind: 'booking', label: b.copy(COPY.cta.booking) };
  if (contact.phone) return { kind: 'call', label: b.copy(COPY.cta.call) };
  if (contact.whatsapp) return { kind: 'whatsapp', label: b.copy(COPY.cta.whatsapp) };
  if (contact.email) return { kind: 'email', label: b.copy(COPY.cta.email) };
  if (contactPage) return { kind: 'page', pageId: 'contact', label: b.copy(COPY.cta.page) } as Cta;
  return undefined;
}

function themeOf(brief: GenerationBrief): SiteSpec['theme'] {
  const style = brief.design.style;
  const base = PALETTES[style];
  const ensure = (color: string, fallback: string) =>
    suggestColor(color, [base.background], 3.2) ??
    (contrastRatio(fallback, base.background) >= 3 ? fallback : base.text);
  const pair =
    FONT_PAIRS.find((candidate) => (candidate.suits as readonly string[]).includes(style)) ?? FONT_PAIRS[0];
  return {
    style,
    palette: {
      primary: ensure(brief.design.palette.primary, base.text),
      accent: ensure(brief.design.palette.accent, base.mutedText),
      ...base,
    },
    typography: { pairId: pair.id },
    radius: THEME[style].radius,
    density: brief.design.density,
    imageTreatment: THEME[style].imageTreatment,
  } as SiteSpec['theme'];
}

export function buildStarterSpec(
  brief: GenerationBrief,
  facts: readonly RegistryFact[],
  candidates: readonly Asset[],
  options: { readonly countryCode?: string | null } = {},
): StarterSpec {
  const b = new Builder(brief, facts, candidates, options.countryCode ?? 'BL');
  const name = clip(brief.identity.name, LIMITS.brandName.max);
  const nameFact = brief.identity.nameFactId;
  if (!nameFact) throw new Error('A starter spec needs a displayable name fact');
  const contact = contactOf(b);
  const hasChannel = Boolean(contact.phone || contact.email || contact.whatsapp);
  const pageKinds = new Set(brief.pagePlan.pages.map((page) => page.kind));
  const cta = primaryCta(b, contact, pageKinds.has('contact'));
  const category = brief.identity.categoryLabel;
  const locality = brief.identity.locality;
  const placeLine: [string, string] = [
    [category?.fr, locality ? `à ${locality}` : ''].filter(Boolean).join(' ') || name,
    [category?.en, locality ? `in ${locality}` : ''].filter(Boolean).join(' ') || name,
  ];

  const pages: SiteSpec['pages'] = brief.pagePlan.pages.map((planned, pageIndex) => {
    const pageId = planned.kind;
    const blocks: Block[] = [];
    let n = 0;
    const id = (type: string) => `${pageId}-${type}-${++n}`.slice(0, 32);
    const at = () => `/pages/${pageIndex}/blocks/${blocks.length}`;
    for (const plannedBlock of planned.blocks) {
      const block = buildBlock(b, plannedBlock, { pageId, planned, name, cta, contact, placeLine, at, id });
      if (block) blocks.push(block);
    }
    const title = b.copy(COPY.page[planned.kind]);
    return {
      id: pageId,
      slug: planned.slug,
      title,
      seo: {
        title:
          pageIndex === 0
            ? b.same(clip(`${name}${locality ? ` · ${locality}` : ''}`, 70), 70)
            : b.copy(COPY.page[planned.kind].map((t) => clip(`${t} · ${name}`, 70))),
        description: b.copy(placeLine.map((line) => clip(line, 200))),
      },
      blocks,
    } as SiteSpec['pages'][number];
  });

  const logo = b.logo();
  const spec = {
    schemaVersion: 1,
    locales: brief.locales.available,
    defaultLocale: brief.locales.default,
    brand: { name, factId: nameFact },
    theme: themeOf(brief),
    contact,
    layout: {
      header: {
        variant: 'simple',
        ...(logo ? { logoAssetId: logo.id } : {}),
        showCta: Boolean(cta),
        ...(cta ? { cta } : {}),
      },
      footer: {
        variant: 'simple',
        showSocials: Boolean(contact.socials?.length),
        showHours: Boolean(contact.hours),
      },
    },
    navigation: {
      items: pages.slice(0, 7).map((page) => ({
        pageId: page.id,
        label: Object.fromEntries(
          Object.entries(page.title).map(([locale, text]) => [locale, clip(text, 24)]),
        ),
      })),
    },
    pages,
    assets: b.assets(),
    seo: {
      title: b.same(clip(`${name}${locality ? ` · ${locality}` : ''}`, 70), 70),
      description: b.copy(placeLine.map((line) => clip(line, 200))),
    },
    settings: {
      noindex: true,
      previewBanner: true,
      analytics: 'cookieless',
      contactForm: { enabled: !hasChannel },
    },
  } as SiteSpec;
  b.todo('/seo/description');
  return { spec, annotations: b.annotations };
}

interface BlockContext {
  readonly pageId: string;
  readonly planned: Plan['pages'][number];
  readonly name: string;
  readonly cta: Cta | undefined;
  readonly contact: SiteSpec['contact'];
  readonly placeLine: readonly [string, string];
  at(): string;
  id(type: string): string;
}

function priceFor(b: Builder, title: string) {
  const fact = b.facts('price').find((candidate) => {
    const ref = (candidate.value as { serviceRef?: string }).serviceRef;
    return ref ? norm(ref) === norm(title) : false;
  });
  if (!fact) return undefined;
  const value = fact.value as { amount: number; currency: string };
  return { amount: value.amount, currency: value.currency, factId: fact.id };
}

function buildBlock(
  b: Builder,
  planned: Plan['pages'][number]['blocks'][number],
  context: BlockContext,
): Block | undefined {
  const { pageId, name, cta, contact } = context;
  const pointer = context.at();
  const variant = planned.variant ?? '';
  switch (planned.type) {
    case 'hero': {
      const home = pageId === 'home';
      const needsImage = variant === 'split' || variant === 'image_full';
      const image = needsImage ? b.image(0, true) : undefined;
      const tagline = b.brief.identity.description;
      const props: Record<string, unknown> = {
        title: home ? b.same(name, LIMITS.heroTitle.max) : b.copy(COPY.page[context.planned.kind]),
        ...(home && b.brief.identity.locality
          ? { eyebrow: b.same(b.brief.identity.locality, LIMITS.eyebrow.max) }
          : {}),
      };
      if (home) {
        props.subtitle = tagline
          ? b.same(tagline, LIMITS.heroSubtitle.max)
          : b.copy(context.placeLine.map((line) => clip(line, 160)));
        if (!tagline) b.todo(`${pointer}/props/subtitle`);
        if (cta) props.primaryCta = cta;
      }
      if (image) props.imageAssetId = image.id;
      return {
        id: context.id('hero'),
        type: 'hero',
        variant: needsImage && !image ? 'centered' : variant,
        props,
      } as Block;
    }
    case 'highlights': {
      const items = (
        [
          'service',
          'amenity',
          'award',
          'year_founded',
          'language_spoken',
          'area_served',
          'payment_method',
        ] as const
      )
        .flatMap((kind) => b.facts(kind).slice(0, 2))
        .slice(0, 4)
        .map((fact) => ({
          icon: ICON_BY_KIND[fact.kind] ?? 'star',
          title: b.same(
            typeof fact.value === 'number' ? String(fact.value) : b.text(fact),
            LIMITS.itemTitle.max,
          ),
          factIds: [fact.id],
        }))
        .filter((item) => Object.values(item.title).every((text) => text.length > 0));
      if (items.length < 2) return undefined;
      return { id: context.id('highlights'), type: 'highlights', variant, props: { items } } as Block;
    }
    case 'services': {
      const kinds = planned.fills?.includes('menu_section')
        ? (['service', 'menu_section'] as const)
        : (['service'] as const);
      const items = kinds
        .flatMap((kind) => b.facts(kind))
        .slice(0, 12)
        .map((fact) => {
          const title = b.text(fact);
          const price = priceFor(b, title);
          return { title: b.same(title, LIMITS.itemTitle.max), ...(price ? { price } : {}) };
        });
      if (items.length === 0) return undefined;
      const heading = context.planned.kind === 'products' ? COPY.heading.products : COPY.heading.services;
      return {
        id: context.id('services'),
        type: 'services',
        variant,
        props: { heading: b.copy(heading), items },
      } as Block;
    }
    case 'menu': {
      const sectionTitles = b.facts('menu_section').map((fact) => b.text(fact));
      const bySection = new Map<string, { name: Localized; price?: ReturnType<typeof priceFor> }[]>();
      for (const fact of b.facts('menu_item')) {
        const value = fact.value as { name: string; section?: string };
        const section =
          value.section && sectionTitles.some((title) => norm(title) === norm(value.section ?? ''))
            ? value.section
            : '';
        const price = priceFor(b, value.name);
        const list = bySection.get(section) ?? [];
        if (list.length < 30)
          list.push({ name: b.same(value.name, LIMITS.itemTitle.max), ...(price ? { price } : {}) });
        bySection.set(section, list);
      }
      const sections = [...bySection.entries()].slice(0, 10).map(([title, items]) => ({
        title: title ? b.same(title, LIMITS.itemTitle.max) : b.copy(COPY.menuSection),
        items,
      }));
      if (sections.length === 0) return undefined;
      return {
        id: context.id('menu'),
        type: 'menu',
        variant,
        props: { heading: b.copy(COPY.heading.menu), sections },
      } as Block;
    }
    case 'about': {
      const own = b.facts('about_summary')[0] ?? b.facts('tagline')[0];
      const image = variant === 'split' || variant === 'story' ? (b.image(1) ?? b.image(0)) : undefined;
      const body = own
        ? b.same(b.text(own), LIMITS.body.max)
        : b.copy(context.placeLine.map((line) => `${name}, ${line}.`));
      if (!own) b.todo(`${pointer}/props/body`);
      return {
        id: context.id('about'),
        type: 'about',
        variant: (variant === 'split' || variant === 'story') && !image ? 'centered' : variant,
        props: {
          heading: b.copy(COPY.heading.about),
          body,
          ...(image ? { imageAssetId: image.id } : {}),
          ...(own ? { factIds: [own.id] } : {}),
        },
      } as Block;
    }
    case 'testimonials': {
      const items = b
        .facts('testimonial')
        .slice(0, 6)
        .map((fact) => {
          const value = fact.value as { quote: string; attribution: string };
          return {
            factId: fact.id,
            quote: b.same(value.quote, LIMITS.quote.max),
            author: clip(value.attribution, 60),
          };
        });
      if (items.length === 0) return undefined;
      return {
        id: context.id('testimonials'),
        type: 'testimonials',
        variant,
        props: { heading: b.copy(COPY.heading.testimonials), items },
      } as Block;
    }
    case 'team': {
      const members = b
        .facts('team_member')
        .slice(0, 12)
        .map((fact) => {
          const value = fact.value as { name: string; role?: string };
          return {
            factId: fact.id,
            name: clip(value.name, 60),
            ...(value.role ? { role: b.same(value.role, LIMITS.itemTitle.max) } : {}),
          };
        });
      if (members.length === 0) return undefined;
      return {
        id: context.id('team'),
        type: 'team',
        variant,
        props: { heading: b.copy(COPY.heading.team), members },
      } as Block;
    }
    case 'gallery': {
      const images = [2, 3, 4, 5, 6, 7, 8, 9].flatMap((index) => b.image(index) ?? []).slice(0, 12);
      if (images.length < 3) return undefined;
      return {
        id: context.id('gallery'),
        type: 'gallery',
        variant,
        props: { heading: b.copy(COPY.heading.gallery), assetIds: images.map((image) => image.id) },
      } as Block;
    }
    case 'hours':
      return contact.hours
        ? ({
            id: context.id('hours'),
            type: 'hours',
            variant,
            props: { heading: b.copy(COPY.heading.hours) },
          } as Block)
        : undefined;
    case 'location':
      return contact.address || contact.geo
        ? ({
            id: context.id('location'),
            type: 'location',
            variant: contact.geo ? variant : 'address_only',
            props: { heading: b.copy(COPY.heading.location), showDirections: true },
          } as Block)
        : undefined;
    case 'contact': {
      const channels = {
        phone: Boolean(contact.phone),
        email: Boolean(contact.email),
        whatsapp: Boolean(contact.whatsapp),
      };
      const form = !channels.phone && !channels.email && !channels.whatsapp;
      return {
        id: context.id('contact'),
        type: 'contact',
        variant,
        props: { heading: b.copy(COPY.heading.contact), showForm: form, channels },
      } as Block;
    }
    case 'cta_banner': {
      if (!cta) return undefined;
      const image = variant === 'image' ? b.image(1) : undefined;
      b.todo(`${pointer}/props/title`);
      return {
        id: context.id('cta'),
        type: 'cta_banner',
        variant: variant === 'image' && !image ? 'solid' : variant,
        props: { title: b.copy(COPY.ctaBanner), cta, ...(image ? { imageAssetId: image.id } : {}) },
      } as Block;
    }
    case 'booking':
      return contact.bookingUrl
        ? ({
            id: context.id('booking'),
            type: 'booking',
            variant: 'link',
            props: { heading: b.copy(COPY.heading.booking), label: b.copy(COPY.bookingLabel) },
          } as Block)
        : undefined;
    case 'faq': {
      const items = (['area_served', 'payment_method', 'language_spoken'] as const).flatMap((kind) => {
        const kindFacts = b.facts(kind).slice(0, 6);
        if (kindFacts.length === 0) return [];
        return [
          {
            question: b.copy(COPY.faq[kind]),
            answer: b.same(kindFacts.map((fact) => b.text(fact)).join(', '), LIMITS.faqAnswer.max),
            factIds: kindFacts.map((fact) => fact.id),
          },
        ];
      });
      if (items.length === 0) return undefined;
      return {
        id: context.id('faq'),
        type: 'faq',
        variant,
        props: { heading: b.copy(COPY.heading.faq), items },
      } as Block;
    }
    default:
      return undefined;
  }
}
