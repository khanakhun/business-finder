import {
  BRIEF_VERSION,
  type BriefOverrides,
  type BriefStyle,
  type GenerationBrief,
  type Offer,
  type PagePlan,
  type RegistryFact,
  type RegistryFactKind,
} from '@bf/contracts';
import { type PagePlanTemplate, type PlanInputs, resolvePlan, selectTemplate } from './page-plan.ts';

// The generation brief (BF-040): built from the registry's facts, the category, the audit and the review themes —
// deterministic, so the same inputs give the same brief. Every hint and selling point names its evidence; nothing
// here is copy for the site (engines write that from facts), and missing facts become warnings, not inventions.

export const SITE_LOCALES = ['fr', 'en', 'nl', 'es', 'de'] as const;

export interface BriefFinding {
  readonly code: string;
  readonly severity: 'critical' | 'major' | 'minor' | 'info';
  readonly recommendation: string;
  readonly offers: readonly string[];
}

export interface BriefInputs {
  readonly businessId: string;
  readonly businessName: string;
  readonly facts: readonly RegistryFact[];
  readonly category: { readonly path: string; readonly labels: { en: string; fr: string } } | null;
  readonly locality: string | null;
  readonly countryCode: string | null;
  readonly hasWebsite: boolean;
  /** Review themes of the workspace's insights: pain tag → mentions. */
  readonly reviewThemes: Readonly<Record<string, number>>;
  readonly findings: readonly BriefFinding[];
  /** The workspace's locales (settings), and the languages detected on the business's current site. */
  readonly workspaceLocales: readonly string[];
  readonly siteLanguages: readonly string[];
  readonly images: { readonly count: number; readonly large: number };
  readonly templates: readonly PagePlanTemplate[];
  readonly offer?: Offer;
  readonly overrides?: BriefOverrides;
}

const display = (facts: readonly RegistryFact[], kind: RegistryFactKind) =>
  facts.filter((fact) => fact.kind === kind && fact.usage === 'display');
const first = (facts: readonly RegistryFact[], kind: RegistryFactKind) => display(facts, kind)[0];

/** Countries whose sites default to French first (Saint-Barthélemy, Saint-Martin, the French Antilles, France). */
const FRENCH_FIRST = new Set(['BL', 'MF', 'GP', 'MQ', 'GF', 'RE', 'FR', 'PM', 'YT']);

const LUXURY_PREFIXES = [
  'lodging.villa_rental_agency',
  'lodging.boutique_hotel',
  'lodging.resort',
  'marine_nautical.boat_charter',
  'food_drink.restaurant.fine_dining',
  'food_drink.private_chef',
  'beauty_wellness.wellness',
  'real_estate',
];
const RESIDENT_PREFIXES = [
  'home_services',
  'home_construction',
  'health_medical',
  'professional_services',
  'finance_insurance',
  'public_community',
  'education',
  'pets_animals',
  'automotive_transport.automotive_services',
  'retail_shopping.food_retail',
];
const TOURISM_PREFIXES = [
  'lodging',
  'marine_nautical',
  'tourism_leisure',
  'automotive_transport.vehicle_rental',
];

const under = (path: string | undefined, prefixes: readonly string[]) =>
  !!path && prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}.`));

/** Remedies for review pain themes: what the site should make easy. */
const REMEDIES: Readonly<Record<string, string>> = {
  booking_friction: 'Make booking prominent: a booking or WhatsApp call to action on every page.',
  unreachable_by_phone: 'Offer WhatsApp and e-mail next to the phone, and show the opening hours.',
  slow_or_no_reply: 'Give a contact form and WhatsApp, with clear opening hours.',
  website_broken_or_outdated: 'A fast, mobile-first site with up-to-date information.',
  no_online_menu_or_prices: 'Publish the menu and the prices the business publishes.',
  hard_to_find_info: 'Put address, hours and contact on the home page.',
  language_barrier: 'Offer the site in French and English.',
  payment_friction: 'State the accepted payment methods.',
  inconsistent_hours: 'Show one clear set of opening hours.',
  poor_communication: 'Explain the services clearly and give direct contact channels.',
};
const MIN_THEME_MENTIONS = 2;

const STYLE_PALETTES: Readonly<Record<BriefStyle, { primary: string; accent: string }>> = {
  luxe: { primary: '#7a5c3e', accent: '#8a6a2f' },
  modern: { primary: '#1f4e79', accent: '#b4532a' },
  warm: { primary: '#9a3f1c', accent: '#7c5a12' },
  minimal: { primary: '#2f3b45', accent: '#4d6b57' },
  coastal: { primary: '#0f5f73', accent: '#a5541f' },
};

function styleFor(
  path: string | undefined,
  market: GenerationBrief['audience']['market'],
): [BriefStyle, string] {
  if (market === 'luxury_tourism') return ['luxe', 'Luxury tourism market (category and island)'];
  if (under(path, ['marine_nautical', 'tourism_leisure'])) return ['coastal', 'Sea and leisure activity'];
  if (under(path, ['food_drink'])) return ['warm', 'Food and drink: a warm, welcoming look'];
  if (under(path, ['health_medical', 'professional_services', 'finance_insurance'])) {
    return ['minimal', 'A sober look builds trust for professional services'];
  }
  return ['modern', 'A clean default for the category'];
}

/** Control, zero-width and bidi characters (built from code points: formatters rewrite escapes). */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
];
const INVISIBLE = new RegExp(
  `[${INVISIBLE_RANGES.map(([from, to]) => `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`).join('')}]`,
  'gu',
);

/** Markup out of operator text: tags, then any angle bracket left (they could reopen a tag or a data block). */
function stripMarkup(text: string): string {
  let previous: string;
  let current = text;
  do {
    previous = current;
    current = current.replace(/<\/?[a-z_]+[^<>]*>/gi, '');
  } while (current !== previous);
  return current.replace(/[<>]/g, '');
}

function sanitizeInstructions(text: string | undefined): string | null {
  if (!text) return null;
  // Normalized first: full-width brackets become < > before markup is stripped.
  const clean = stripMarkup(text.normalize('NFKC'))
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  return clean || null;
}

function displayCounts(facts: readonly RegistryFact[]): Partial<Record<RegistryFactKind, number>> {
  const counts: Partial<Record<RegistryFactKind, number>> = {};
  for (const fact of facts) if (fact.usage === 'display') counts[fact.kind] = (counts[fact.kind] ?? 0) + 1;
  return counts;
}

function planFor(inputs: BriefInputs, planInputs: PlanInputs): PagePlan {
  const overrides = inputs.overrides;
  const byId = overrides?.pagePlanId
    ? inputs.templates.find((template) => template.id === overrides.pagePlanId)
    : undefined;
  const { template, matched } = byId
    ? { template: byId, matched: byId.match[0] ?? byId.id }
    : selectTemplate(inputs.templates, inputs.category?.path ?? null);
  if (!overrides?.pages) return resolvePlan(template, matched, planInputs);
  // A custom page list: the template's pages of those kinds, in the person's order (kinds it lacks come from the
  // default plan). A page the person asked for is kept even with few facts; its blocks still need their facts.
  const fallback = inputs.templates.find((candidate) => candidate.match.includes('default'));
  const pages = overrides.pages.flatMap((kind) => {
    const page =
      template.pages.find((candidate) => candidate.kind === kind) ??
      fallback?.pages.find((candidate) => candidate.kind === kind);
    return page ? [{ ...page, requires: undefined }] : [];
  });
  return resolvePlan({ ...template, pages }, `${matched} (custom pages)`, planInputs);
}

export function buildBrief(inputs: BriefInputs): GenerationBrief {
  const { facts } = inputs;
  const path = inputs.category?.path;
  const counts = displayCounts(facts);

  // Identity: the name the workspace states, else the display name; a description from the business's own words.
  const nameFact = first(facts, 'name');
  const tagline = first(facts, 'tagline') ?? first(facts, 'about_summary');
  const name = typeof nameFact?.value === 'string' ? nameFact.value : inputs.businessName;

  // Market: from the category, the island's luxury tourism and the review themes.
  const categoryFact = facts.find((fact) => fact.kind === 'category');
  const market: GenerationBrief['audience']['market'] = under(path, LUXURY_PREFIXES)
    ? 'luxury_tourism'
    : under(path, TOURISM_PREFIXES)
      ? 'tourism'
      : under(path, RESIDENT_PREFIXES)
        ? 'residents'
        : 'mixed';
  const hints: GenerationBrief['audience']['hints'] = [];
  if (categoryFact)
    hints.push({
      text:
        market === 'luxury_tourism'
          ? 'Visitors of a luxury destination: refined, image-led, bilingual.'
          : market === 'tourism'
            ? 'Mostly visitors: practical information and booking first.'
            : market === 'residents'
              ? 'Mostly residents: services, reliability and how to reach the business.'
              : 'Residents and visitors alike.',
      evidence: [categoryFact.id],
    });
  const languages = display(facts, 'language_spoken');
  if (languages.length > 0)
    hints.push({
      text: 'The business serves customers in several languages.',
      evidence: languages.map((f) => f.id).slice(0, 10),
    });

  // Locales: the person's choice, else the workspace's and the current site's, French first in French territories.
  const supported = (locale: string) => (SITE_LOCALES as readonly string[]).includes(locale);
  const wanted = inputs.overrides?.locales ?? [...inputs.workspaceLocales, ...inputs.siteLanguages];
  let available = [
    ...new Set(wanted.map((locale) => locale.slice(0, 2).toLowerCase()).filter(supported)),
  ].slice(0, 4);
  if (available.length === 0)
    available = FRENCH_FIRST.has(inputs.countryCode ?? 'BL') ? ['fr', 'en'] : ['en'];
  const primarySite = inputs.siteLanguages
    .map((locale) => locale.slice(0, 2))
    .find((locale) => available.includes(locale));
  const defaultLocale =
    inputs.overrides?.locales?.[0] ??
    primarySite ??
    (FRENCH_FIRST.has(inputs.countryCode ?? 'BL') && available.includes('fr')
      ? 'fr'
      : (available[0] ?? 'en'));

  const planInputs: PlanInputs = {
    facts: counts,
    images: inputs.images.count,
    largeImages: inputs.images.large,
  };
  const pagePlan = planFor(inputs, planInputs);

  // Selling points: facts the business states about itself, then a strong reputation in reviews.
  const sellingPoints: GenerationBrief['sellingPoints'] = [];
  const point = (text: string, evidence: string[]) => {
    if (sellingPoints.length < 6 && evidence.length > 0)
      sellingPoints.push({ text: text.slice(0, 160), evidence });
  };
  for (const service of display(facts, 'service').slice(0, 3))
    point(`Offers ${String(service.value)}`, [service.id]);
  for (const award of display(facts, 'award').slice(0, 1))
    point(`Recognised: ${String(award.value)}`, [award.id]);
  const founded = first(facts, 'year_founded');
  if (founded) point('Long-established business', [founded.id]);
  const booking = first(facts, 'booking_provider');
  if (booking) point('Online booking already in place', [booking.id]);
  if ((inputs.reviewThemes.positive_strong_reputation ?? 0) >= 3)
    point('Customers praise it strongly in reviews', ['theme_positive_strong_reputation']);

  const painPoints = Object.entries(inputs.reviewThemes)
    .filter(([tag, count]) => REMEDIES[tag] && count >= MIN_THEME_MENTIONS)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, 8)
    .map(([tag]) => ({ tag, remedy: REMEDIES[tag] as string }));

  // Offer: the person's, else a redesign when there is a site to improve.
  const offer: Offer = inputs.offer ?? (inputs.hasWebsite ? 'website_redesign' : 'new_website');
  const severity = { critical: 0, major: 1, minor: 2, info: 3 } as const;
  const improvements = [...inputs.findings]
    .filter((finding) => finding.offers.includes(offer) && finding.severity !== 'info')
    .sort((a, b) => severity[a.severity] - severity[b.severity] || a.code.localeCompare(b.code))
    .slice(0, 10)
    .map((finding) => ({ ref: `finding_${finding.code}`, text: finding.recommendation.slice(0, 200) }));

  // Design: the person's style, else the market's; the brand colour when the business has one.
  const [autoStyle, styleReason] = styleFor(path, market);
  const style = inputs.overrides?.style ?? autoStyle;
  const brand = first(facts, 'brand_color');
  const preset = STYLE_PALETTES[style];
  const design: GenerationBrief['design'] = {
    style,
    reasons: [inputs.overrides?.style ? 'Chosen by the workspace' : styleReason],
    palette: {
      primary: typeof brand?.value === 'string' ? brand.value.toLowerCase() : preset.primary,
      accent: preset.accent,
      source: brand ? 'brand' : 'style',
    },
    imagery:
      market === 'luxury_tourism'
        ? 'Bright, airy photos of the place and the sea; no people posing.'
        : under(path, ['food_drink'])
          ? 'Close, warm photos of dishes, drinks and the room.'
          : 'Real photos of the place, the work and the products.',
    density: style === 'luxe' ? 'airy' : under(path, ['retail_shopping']) ? 'compact' : 'comfortable',
  };

  const doNotMention = [
    'Negative review content or ratings from other platforms',
    'Prices the business does not publish itself',
    'Anything not in the fact registry (awards, years, staff, guarantees)',
  ];
  if (!counts.price) doNotMention.push('Prices of any kind (no published prices)');

  const warnings: GenerationBrief['warnings'] = [];
  const warn = (code: GenerationBrief['warnings'][number]['code'], message: string) =>
    warnings.push({ code, message });
  if (!counts.phone)
    warn('no_display_phone', 'No phone number may be displayed (none from a licensed source).');
  if (!counts.email) warn('no_display_email', 'No e-mail address may be displayed.');
  if (!counts.phone && !counts.email && !counts.whatsapp)
    warn('no_contact_channel', 'No contact channel: the site falls back to its contact form.');
  if (!counts.hours) warn('no_hours', 'No opening hours to show.');
  if (inputs.images.large === 0)
    warn('no_large_image', 'No image at least 1200 px wide: heroes use a text layout.');
  if (available.length === 1) warn('single_locale', `Single locale (${available[0]}).`);
  if (!counts.service && !counts.menu_item) warn('no_services', 'No services or menu items are known.');
  if (!facts.some((fact) => fact.source === 'owner_site' || fact.source === 'jsonld'))
    warn('no_owner_site_facts', 'Nothing read from the business’s own website.');
  const displayTotal = facts.filter((fact) => fact.usage === 'display').length;
  if (displayTotal < 5)
    warn('few_facts', `Only ${displayTotal} displayable facts: the site will stay short.`);

  return {
    briefVersion: BRIEF_VERSION,
    businessId: inputs.businessId,
    identity: {
      name: name.slice(0, 200),
      nameFactId: nameFact?.id ?? null,
      categoryPath: path ?? null,
      categoryLabel: inputs.category?.labels ?? null,
      locality: inputs.locality,
      area: inputs.locality,
      description: typeof tagline?.value === 'string' ? tagline.value.slice(0, 600) : null,
    },
    offer: { id: offer, improvements },
    audience: { market, hints: hints.slice(0, 6) },
    locales: {
      available,
      default: available.includes(defaultLocale) ? defaultLocale : (available[0] as string),
    },
    pagePlan,
    sellingPoints,
    painPoints,
    design,
    constraints: {
      tone:
        inputs.overrides?.tone ??
        (market === 'luxury_tourism'
          ? 'refined'
          : under(path, RESIDENT_PREFIXES)
            ? 'professional'
            : 'friendly'),
      noInventedFacts: true,
      neutralCopyWhenMissing: true,
      frenchTypography: available.includes('fr'),
      doNotMention,
      maxHeadlineChars: 60,
      maxParagraphChars: 1500,
    },
    extraInstructions: sanitizeInstructions(inputs.overrides?.extraInstructions),
    warnings,
  };
}
