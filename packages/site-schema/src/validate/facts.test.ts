import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SiteSpec } from '../spec/site.ts';
import { type FactRegistry, FactRegistrySchema, literals, validateFacts } from './facts.ts';

const read = (path: string) =>
  JSON.parse(readFileSync(new URL(`../../fixtures/${path}`, import.meta.url), 'utf8'));
const salon = (): SiteSpec => read('salon-gustavia.json');
const registry = (name = 'salon-gustavia'): FactRegistry =>
  FactRegistrySchema.parse(read(`facts/${name}.json`));
const found = (spec: SiteSpec, facts = registry()) =>
  validateFacts(spec, facts).map((issue) => `${issue.code}@${issue.path.join('.')}`);
const hero = (spec: SiteSpec) => {
  const block = spec.pages[0]?.blocks[0];
  if (block?.type !== 'hero') throw new Error('no hero');
  return block.props;
};
const testimonial = (spec: SiteSpec) => {
  const block = spec.pages[0]?.blocks[3];
  if (block?.type !== 'testimonials' || !block.props.items[0]) throw new Error('no testimonial');
  return block.props.items[0];
};
const withFacts = (extra: FactRegistry['facts']) => ({ facts: [...registry().facts, ...extra] });
const fact = (id: string, kind: string, value: unknown) =>
  ({ id, kind, value, source: 'website', confidence: 1 }) as FactRegistry['facts'][number];

describe('validateFacts', () => {
  it.each(['salon-gustavia', 'cafe-saint-jean', 'hardware-store-lorient', 'villa-agency'])(
    '%s states only its facts',
    (name) => {
      expect(validateFacts(read(`${name}.json`), registry(name))).toEqual([]);
    },
  );

  it('refuses unknown fact ids, in a value and in a list', () => {
    const spec = salon();
    if (spec.contact.phone) spec.contact.phone.factId = 'phone.other';
    const highlights = spec.pages[0]?.blocks[1];
    if (highlights?.type === 'highlights') highlights.props.items[0]?.factIds?.push('award.best');
    expect(found(spec)).toEqual([
      'fact_unknown@contact.phone.factId',
      'fact_unknown@pages.0.blocks.1.props.items.0.factIds.1',
    ]);
  });

  it('checks the kind and the value of contact facts, the address included', () => {
    const spec = salon();
    if (spec.contact.phone) spec.contact.phone.value = '+590590999999';
    if (spec.contact.email) spec.contact.email.factId = 'phone.main';
    if (spec.contact.address) spec.contact.address.formatted = '1 rue Inventée, Gustavia';
    spec.brand.name = 'Salon Soleil';
    expect(found(spec)).toEqual([
      'fact_mismatch@brand',
      'fact_mismatch@contact.phone',
      'fact_kind@contact.email.factId',
      'fact_mismatch@contact.address',
    ]);
  });

  it('checks a testimonial by its place: kind, quote in its language, author, rating', () => {
    const quote = salon();
    testimonial(quote).quote.fr = 'Le meilleur salon du monde !';
    expect(found(quote)).toEqual(['fact_mismatch@pages.0.blocks.3.props.items.0']);
    const noAuthor = salon();
    delete testimonial(noAuthor).author;
    testimonial(noAuthor).factId = 'phone.main';
    expect(found(noAuthor)).toEqual(['fact_kind@pages.0.blocks.3.props.items.0.factId']);
    const rating = salon();
    testimonial(rating).rating = 4;
    expect(found(rating)).toEqual(['fact_mismatch@pages.0.blocks.3.props.items.0']);
    // A translation of the quote in another locale is the writer's.
    const translated = salon();
    testimonial(translated).quote.en = 'Lovely welcome and a perfect haircut.';
    expect(found(translated)).toEqual([]);
  });

  it('checks prices and team members against their facts', () => {
    const spec = salon();
    const services = spec.pages[0]?.blocks[2];
    if (services?.type === 'services' && services.props.items[0]?.price)
      services.props.items[0].price.amount = 55;
    spec.pages[0]?.blocks.push({
      id: 'team-home9',
      type: 'team',
      variant: 'grid',
      props: { members: [{ factId: 'review.1', name: 'Claire D.' }] },
    });
    expect(found(spec)).toEqual([
      'fact_kind@pages.0.blocks.5.props.members.0.factId',
      'fact_mismatch@pages.0.blocks.2.props.items.0.price',
    ]);
  });

  it('refuses invented literals anywhere in the site, not only on pages', () => {
    const spec = salon();
    hero(spec).subtitle = {
      fr: 'Depuis 2015, appelez le 0590 00 01 01, une coupe dès 65 €.',
      en: 'Since 1998, call +590 590 12 34 56, cuts from €35.',
    };
    spec.seo.description.en =
      'Write to hello@elsewhere.example — salon in Gustavia, Saint-Barthélemy, open since 1987 for cuts and colour.';
    spec.layout.footer.tagline = { fr: 'Coupe à 15 euros', en: 'Cuts for 15 euros' };
    expect(
      validateFacts(spec, registry()).map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    ).toEqual([
      'layout.footer.tagline.fr: Remove the price "15 euros": only published prices (facts) may appear.',
      'layout.footer.tagline.en: Remove the price "15 euros": only published prices (facts) may appear.',
      'pages.0.blocks.0.props.subtitle.en: Remove the phone number "+590 590 12 34 56" or use the contact facts.',
      'pages.0.blocks.0.props.subtitle.en: Remove the price "€35": only published prices (facts) may appear.',
      'pages.0.blocks.0.props.subtitle.en: Remove the year 1998: it is not a fact.',
      'seo.description.en: Remove the e-mail address "hello@elsewhere.example": it is not a fact.',
      'seo.description.en: Remove the year 1987: it is not a fact.',
    ]);
  });

  it('compares phone numbers by their national number and prices with their currency', () => {
    const spec = salon();
    hero(spec).subtitle = {
      fr: 'Appelez le (0590) 00-01-01 ou le 0590/000101 — 65 €.',
      en: 'Call +590 590 00 01 01, $65.',
    };
    expect(validateFacts(spec, registry()).map((issue) => issue.message)).toEqual([
      'Remove the price "$65": only published prices (facts) may appear.',
    ]);
  });

  it('accepts numbers a fact states (a legal id, a share capital)', () => {
    const spec = salon();
    hero(spec).subtitle = {
      fr: 'SIRET 123 456 789 00012, capital 10 000 €.',
      en: 'SIRET 123 456 789 00012, capital €10,000.',
    };
    expect(found(spec)).toContain('unsupported_literal@pages.0.blocks.0.props.subtitle.fr');
    const legal = withFacts([
      fact('legal.siret', 'legal_id', 'SIRET 123 456 789 00012'),
      fact('legal.capital', 'legal_id', 'Capital 10000 EUR'),
    ]);
    expect(found(spec, legal)).toEqual([]);
  });

  it('never takes a price or a year from the digits of a phone, an address or the hours', () => {
    const spec = salon();
    hero(spec).subtitle = { fr: 'Coupe 59 €, depuis 1800.', en: 'Cut €12, since 1800.' };
    expect(found(spec)).toEqual([
      'unsupported_literal@pages.0.blocks.0.props.subtitle.fr',
      'unsupported_literal@pages.0.blocks.0.props.subtitle.fr',
      'unsupported_literal@pages.0.blocks.0.props.subtitle.en',
      'unsupported_literal@pages.0.blocks.0.props.subtitle.en',
    ]);
  });

  it('scans the hours note and compares the address parts', () => {
    const spec = salon();
    if (spec.contact.hours)
      spec.contact.hours.note = { fr: 'Fermé depuis 1998, appelez 0690 99 99 99', en: 'Closed since 1998' };
    if (spec.contact.address) spec.contact.address.street = '99 avenue Inventée';
    expect(found(spec)).toEqual([
      'fact_mismatch@contact.address.street',
      'unsupported_literal@contact.hours.note.fr',
      'unsupported_literal@contact.hours.note.fr',
      'unsupported_literal@contact.hours.note.en',
    ]);
  });

  it("compares a team member's role when both say one", () => {
    const villa: SiteSpec = read('villa-agency.json');
    const team = villa.pages[0]?.blocks[2];
    if (team?.type === 'team' && team.props.members[0])
      team.props.members[0].role = { en: 'Owner', fr: 'Propriétaire' };
    expect(validateFacts(villa, registry('villa-agency')).map((issue) => issue.code)).toEqual([
      'fact_mismatch',
    ]);
  });

  it('compares e-mail addresses as addresses, not as words', () => {
    const spec = salon();
    if (spec.contact.email) spec.contact.email.value = 'bonjour@salon.lumiere.example';
    hero(spec).subtitle = {
      fr: 'Écrivez à bonjour_salon-lumiere@example.fr',
      en: 'Write to bonjour@salon-lumiere.example',
    };
    expect(found(spec)).toEqual([
      'fact_mismatch@contact.email',
      'unsupported_literal@pages.0.blocks.0.props.subtitle.fr',
    ]);
  });

  it('tells North American numbers apart (no last-9-digits match between full numbers)', () => {
    const spec = salon();
    hero(spec).subtitle = { fr: 'Appelez le +1 312 555 0100', en: 'Call +1 212 555 0100' };
    const facts = withFacts([fact('phone.us', 'phone', '+1 212 555 0100')]);
    expect(found(spec, facts)).toEqual(['unsupported_literal@pages.0.blocks.0.props.subtitle.fr']);
  });

  it('matches address parts as whole words, years an award states, and a real address spelled out', () => {
    const street = salon();
    if (street.contact.address) street.contact.address.street = '2 rue du Port';
    expect(found(street)).toEqual(['fact_mismatch@contact.address.street']);
    const award = salon();
    hero(award).subtitle = { fr: 'Prix 2019 et prix 2015-2019', en: 'Award 2019' };
    expect(found(award, withFacts([fact('award.1', 'award', 'Prix du meilleur salon 2015-2019')]))).toEqual(
      [],
    );
    const spelled = salon();
    hero(spelled).subtitle = {
      fr: 'Écrivez à bonjour (at) salon-lumiere.example',
      en: 'Write to bonjour @ salon-lumiere.example',
    };
    expect(found(spelled)).toEqual([]);
  });

  it('matches national numbers without a trunk 0 and the "(0)" style, not a 00 prefix as a trunk', () => {
    const spec = salon();
    hero(spec).subtitle = { fr: 'Appelez le (212) 555-0100', en: 'Call +44 (0)20 7946 0000' };
    const facts = withFacts([
      fact('phone.us', 'phone', '+12125550100'),
      fact('phone.uk', 'phone', '+442079460000'),
    ]);
    expect(found(spec, facts)).toEqual([]);
    const contact = salon();
    if (contact.contact.phone) contact.contact.phone.value = '+12125550100';
    const national = {
      facts: registry().facts.map((f) => (f.kind === 'phone' ? { ...f, value: '(212) 555-0100' } : f)),
    };
    expect(found(contact, national)).not.toContain('fact_mismatch@contact.phone');
    // `0044…` is international (`00` is no trunk 0): equal to `+44…`, and not cut to `044…`.
    const prefixed = salon();
    hero(prefixed).subtitle = { fr: 'Appelez le 0044 20 7946 0000', en: 'Call 0044 20 7946 0001' };
    expect(found(prefixed, facts)).toEqual(['unsupported_literal@pages.0.blocks.0.props.subtitle.en']);
  });

  it('takes years only from what facts state as years, and phone-like ids whole', () => {
    const spec = salon();
    hero(spec).subtitle = { fr: 'Depuis 1800, RCS 123-456-789.', en: 'Since 1800, N° 12/345/678.' };
    const facts = withFacts([
      fact('other.clients', 'other', '1 800 clients satisfaits'),
      fact('legal.rcs', 'legal_id', 'RCS 123-456-789'),
      fact('legal.no', 'legal_id', 'N° 12/345/678'),
    ]);
    expect(validateFacts(spec, facts).map((issue) => issue.message)).toEqual([
      'Remove the year 1800: it is not a fact.',
      'Remove the year 1800: it is not a fact.',
    ]);
  });

  it('refuses a registry with two facts of the same id', () => {
    const facts = registry().facts;
    expect(FactRegistrySchema.safeParse({ facts: [...facts, facts[0]] }).success).toBe(false);
  });
});

describe('literals', () => {
  it.each([
    ['1 250 €', [{ amount: 1250, currency: 'EUR' }]],
    ['1 250 €', [{ amount: 1250, currency: 'EUR' }]],
    ['1 250 €', [{ amount: 1250, currency: 'EUR' }]],
    ['1.250,00 €', [{ amount: 1250, currency: 'EUR' }]],
    ['€1,250', [{ amount: 1250, currency: 'EUR' }]],
    ['12,50 €', [{ amount: 12.5, currency: 'EUR' }]],
    ['Prix: 1 200€', [{ amount: 1200, currency: 'EUR' }]],
    ['1 250 000 €', [{ amount: 1250000, currency: 'EUR' }]],
    ['65 euros', [{ amount: 65, currency: 'EUR' }]],
    ['$65', [{ amount: 65, currency: 'USD' }]],
    ['Coupe 35  €', [{ amount: 35, currency: 'EUR' }]],
    ['CHF 35', [{ amount: 35, currency: 'CHF' }]],
    ['35 francs', [{ amount: 35, currency: 'CHF' }]],
  ])('reads the price in %j', (text, expected) => {
    expect(literals(text).prices.map(({ amount, currency }) => ({ amount, currency }))).toEqual(expected);
    expect(literals(text).phones).toEqual([]);
  });

  it.each([
    ['(0590) 27 00 00', ['(0590) 27 00 00']],
    ['05/90/27/00/00', ['05/90/27/00/00']],
    ['０５９０２７００００', ['0590270000']],
    ['0690 12 34 56', ['0690 12 34 56']],
  ])('finds the phone number in %j', (text, expected) => {
    expect(literals(text).phones.map((phone) => phone.normalize('NFKC').replace(/\s/g, ' '))).toEqual(
      expected,
    );
  });

  it('reads dates as years, not phone numbers, and books as books', () => {
    expect(literals('Le 12/05/2024 et le 2023-06-01')).toMatchObject({ phones: [], years: [2024, 2023] });
    expect(literals('Plus de 2 000 livres en rayon').prices).toEqual([]);
    expect(literals('20 livres sterling').prices).toEqual([
      { amount: 20, currency: 'GBP', text: '20 livres sterling' },
    ]);
  });

  it('reads years, year ranges and areas apart', () => {
    expect(literals('Ouvert de 2015-2024, terrain de 2000 m², depuis 1987')).toEqual({
      phones: [],
      emails: [],
      prices: [],
      years: [2015, 2024, 1987],
    });
  });

  it('finds e-mail addresses spelled out, in any case, but not a handle after a word', () => {
    expect(
      literals('faux @ exemple.fr, faux(at)exemple.fr, faux [at] exemple.fr, faux (AT) exemple.fr').emails,
    ).toHaveLength(4);
    expect(literals('Suivez-nous @salon.lumiere sur Instagram').emails).toEqual([]);
  });

  it('finds unicode and full-width e-mail addresses', () => {
    expect(literals('faux@salón.fr ou faux＠salon.fr').emails).toEqual(['faux@salón.fr', 'faux@salon.fr']);
  });
});
