import type { RegistryFact } from '@bf/contracts';
import { type Asset, validateFacts, validateSite } from '@bf/site-schema';
import { describe, expect, it } from 'vitest';
import { type BriefInputs, buildBrief } from '../domain/brief/build-brief.ts';
import { buildStarterSpec } from '../domain/brief/starter-spec.ts';
import { toSiteFactRegistry } from '../domain/facts/site-facts.ts';
import { pagePlans } from './page-plans.ts';

// The brief and the starter spec (BF-040): deterministic briefs with evidence and warnings, and starter specs that
// pass the BF-033 validators (schema, semantics, facts) with zero errors for thin and rich businesses alike.

let counter = 0;
const at = '2026-10-16T12:00:00.000Z';
function fact(kind: RegistryFact['kind'], value: unknown, extra: Partial<RegistryFact> = {}): RegistryFact {
  counter++;
  return {
    id: `fact_${kind}_${counter.toString(16).padStart(12, '0')}`,
    kind,
    value,
    source: 'owner_site',
    sourceRef: 'https://cafe.example/',
    confidence: 0.9,
    observedAt: at,
    usage: 'display',
    ...extra,
  } as RegistryFact;
}

const image = (n: number, width = 1600): Asset =>
  ({
    id: `img-candidate-${n}`,
    kind: 'image',
    url: `https://assets.bf-sites.test/b/${n}.jpg`,
    width,
    height: 1000,
    alt: { fr: `Photo ${'abcdefghij'[n]}`, en: `Photo ${'abcdefghij'[n]}` },
    license: 'stock',
  }) as Asset;

const cafeFacts = (): RegistryFact[] => [
  fact('name', 'Café du Port'),
  fact('tagline', 'Le petit-déjeuner face au port de Gustavia'),
  fact('phone', '+590590000101'),
  fact('email', 'bonjour@cafe-du-port.example'),
  fact('address', 'Rue du Port, Gustavia'),
  fact('geo', { lat: 17.8962, lng: -62.8498 }),
  fact('hours', {
    weekly: ['tue', 'wed', 'thu', 'fri', 'sat'].map((day) => ({ day, opens: '07:00', closes: '14:00' })),
  }),
  fact('service', 'Petit-déjeuner'),
  fact('service', 'Brunch du dimanche'),
  fact('menu_section', 'Boissons'),
  ...['Expresso', 'Cappuccino', 'Jus pressé', 'Croissant', 'Tartine', 'Omelette', 'Pancakes'].map((name, i) =>
    fact('menu_item', { name, ...(i < 3 ? { section: 'Boissons' } : {}) }),
  ),
  fact('price', { amount: 2.5, currency: 'EUR', serviceRef: 'Expresso' }),
  fact('testimonial', {
    quote: 'Le meilleur café de l’île',
    attribution: 'Julie D.',
    sourcePage: 'https://cafe.example/',
  }),
  fact('social', { network: 'instagram', url: 'https://www.instagram.com/cafeduport.example' }),
  fact('category', 'food_drink.cafe', { source: 'golden_record', usage: 'internal' }),
  fact('phone', '+590590009999', { source: 'provider_restricted', usage: 'internal' }),
];

const inputs = (overrides: Partial<BriefInputs> = {}): BriefInputs => ({
  businessId: '0199f6a4-5b1c-7d2e-8f30-1a2b3c4d5e6f',
  businessName: 'Café du Port',
  facts: cafeFacts(),
  category: { path: 'food_drink.cafe', labels: { en: 'Café', fr: 'Café' } },
  locality: 'Gustavia',
  countryCode: 'BL',
  hasWebsite: true,
  reviewThemes: { booking_friction: 3, positive_strong_reputation: 5, long_wait_times: 1 },
  findings: [
    {
      code: 'no_mobile_viewport',
      severity: 'major',
      recommendation: 'Make the site readable on phones.',
      offers: ['website_redesign'],
    },
    {
      code: 'parked_domain',
      severity: 'critical',
      recommendation: 'Publish a real website.',
      offers: ['new_website'],
    },
  ],
  workspaceLocales: ['fr', 'en'],
  siteLanguages: ['fr'],
  images: { count: 6, large: 2 },
  templates: pagePlans(),
  ...overrides,
});

const VALIDATE = { assetHosts: ['assets.bf-sites.test'], mode: 'preview' as const };
function expectValid(brief: ReturnType<typeof buildBrief>, facts: RegistryFact[], assets: Asset[]) {
  const { spec, annotations } = buildStarterSpec(brief, facts, assets, { countryCode: 'BL' });
  const issues = validateSite(spec, VALIDATE).filter((issue) => issue.severity === 'error');
  expect(issues).toEqual([]);
  expect(
    validateFacts(spec, toSiteFactRegistry(facts)).filter((issue) => issue.severity === 'error'),
  ).toEqual([]);
  return { spec, annotations };
}

describe('buildBrief', () => {
  it('builds a cited, deterministic brief for a café', () => {
    const facts = cafeFacts();
    const brief = buildBrief(inputs({ facts }));
    expect(brief).toEqual(buildBrief(inputs({ facts })));
    expect(brief.identity).toMatchObject({
      name: 'Café du Port',
      categoryPath: 'food_drink.cafe',
      locality: 'Gustavia',
    });
    expect(brief.identity.description).toBe('Le petit-déjeuner face au port de Gustavia');
    expect(brief.locales).toEqual({ available: ['fr', 'en'], default: 'fr' });
    expect(brief.offer).toEqual({
      id: 'website_redesign',
      improvements: [{ ref: 'finding_no_mobile_viewport', text: 'Make the site readable on phones.' }],
    });
    expect(brief.pagePlan.id).toBe('food_drink');
    expect(brief.pagePlan.pages.map((page) => page.kind)).toEqual(['home', 'menu', 'contact']);
    expect(brief.pagePlan.collapsed.map((page) => page.kind)).toEqual(['about']);
    expect(brief.sellingPoints.map((point) => point.evidence[0])).toEqual([
      expect.stringMatching(/^fact_service_/),
      expect.stringMatching(/^fact_service_/),
      'theme_positive_strong_reputation',
    ]);
    expect(brief.painPoints.map((pain) => pain.tag)).toEqual(['booking_friction']);
    expect(brief.design).toMatchObject({ style: 'warm', palette: { source: 'style' } });
    expect(brief.constraints).toMatchObject({
      tone: 'friendly',
      frenchTypography: true,
      noInventedFacts: true,
    });
    expect(brief.warnings).toEqual([]);
    expect(brief.audience.hints[0]?.evidence[0]).toMatch(/^fact_category_/);
  });

  it('warns about what is missing and never shows restricted facts', () => {
    const facts = [
      fact('name', 'Quincaillerie Lorient', { source: 'provider_restricted', usage: 'display' }),
      fact('phone', '+590590000202', { source: 'provider_restricted', usage: 'internal' }),
    ];
    const brief = buildBrief(
      inputs({
        businessName: 'Quincaillerie Lorient',
        facts,
        category: {
          path: 'retail_shopping.home_retail',
          labels: { en: 'Hardware store', fr: 'Quincaillerie' },
        },
        hasWebsite: false,
        reviewThemes: {},
        findings: [],
        workspaceLocales: ['fr'],
        siteLanguages: [],
        images: { count: 0, large: 0 },
      }),
    );
    expect(brief.offer.id).toBe('new_website');
    expect(brief.warnings.map((warning) => warning.code)).toEqual([
      'no_display_phone',
      'no_display_email',
      'no_contact_channel',
      'no_hours',
      'no_large_image',
      'single_locale',
      'no_services',
      'no_owner_site_facts',
      'few_facts',
    ]);
    expect(brief.pagePlan.pages.map((page) => page.kind)).toEqual(['home']);
    const { spec } = expectValid(brief, facts, []);
    expect(spec.contact).toEqual({});
    expect(spec.settings.contactForm.enabled).toBe(true);
    expect(JSON.stringify(spec)).not.toContain('590590000202');
  });

  it('applies overrides: locales, style, tone, custom pages, sanitized instructions', () => {
    const facts = cafeFacts();
    const brief = buildBrief(
      inputs({
        facts,
        overrides: {
          locales: ['en', 'fr'],
          style: 'coastal',
          tone: 'refined',
          pages: ['home', 'services', 'contact'],
          extraInstructions: 'Mettre en avant la terrasse <b>vue mer</b>​\u0007 ',
        },
      }),
    );
    expect(brief.locales).toEqual({ available: ['en', 'fr'], default: 'en' });
    expect(brief.design.style).toBe('coastal');
    expect(brief.constraints.tone).toBe('refined');
    expect(brief.pagePlan.pages.map((page) => page.kind)).toEqual(['home', 'services', 'contact']);
    expect(brief.extraInstructions).toBe('Mettre en avant la terrasse vue mer');
    expectValid(brief, facts, [image(0), image(1), image(2), image(3), image(4), image(5)]);
  });

  it('uses the brand colour, and a page plan chosen by id', () => {
    const facts = [...cafeFacts(), fact('brand_color', '#0A7CFF')];
    const brief = buildBrief(inputs({ facts, overrides: { pagePlanId: 'trades_services' } }));
    expect(brief.design.palette).toMatchObject({ primary: '#0a7cff', source: 'brand' });
    expect(brief.pagePlan.id).toBe('trades_services');
  });
});

describe('buildStarterSpec', () => {
  it('turns a rich brief into a valid spec with facts, prices, hours and placeholders marked', () => {
    const facts = cafeFacts();
    const brief = buildBrief(inputs({ facts }));
    const assets = [image(0), image(1), image(2), image(3), image(4), image(5, 800)];
    const { spec, annotations } = expectValid(brief, facts, assets);
    expect(spec.brand).toMatchObject({ name: 'Café du Port' });
    expect(spec.contact.phone?.value).toBe('+590590000101');
    expect(spec.contact.hours?.weekly.tue).toEqual([{ open: '07:00', close: '14:00' }]);
    expect(spec.layout.header.cta?.kind).toBe('call');
    expect(spec.pages.map((page) => page.slug)).toEqual(['', 'menu', 'contact']);
    const menu = spec.pages[1]?.blocks.find((block) => block.type === 'menu');
    expect(JSON.stringify(menu)).toContain('"amount":2.5');
    for (const page of spec.pages) expect(page.blocks[0]?.type).toBe('hero');
    expect(Object.keys(annotations)).toContain('/seo/description');
    expect(spec.settings).toMatchObject({ noindex: true, previewBanner: true });
  });

  it('is valid for every page plan template, with and without images', () => {
    for (const template of pagePlans()) {
      for (const assets of [[], [image(0), image(1), image(2), image(3), image(4), image(5), image(6)]]) {
        const facts = cafeFacts();
        const brief = buildBrief(
          inputs({
            facts,
            overrides: { pagePlanId: template.id },
            images: { count: assets.length, large: assets.length },
          }),
        );
        expectValid(brief, facts, assets);
      }
    }
  });

  it('keeps a booking link only on a known booking host', () => {
    const facts = [
      ...cafeFacts(),
      fact('booking_provider', { url: 'https://www.planity.com/cafe-du-port', provider: 'Planity' }),
      fact('booking_provider', { url: 'https://evil.example/book', provider: 'Unknown' }),
    ];
    const brief = buildBrief(
      inputs({ facts, category: { path: 'beauty_wellness.wellness.spa', labels: { en: 'Spa', fr: 'Spa' } } }),
    );
    const { spec } = expectValid(brief, facts, [image(0)]);
    expect(spec.contact.bookingUrl?.value).toBe('https://www.planity.com/cafe-du-port');
    expect(spec.layout.header.cta?.kind).toBe('booking');
  });
});
