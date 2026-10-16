import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SiteSpec } from '../spec/site.ts';
import { type FactRegistry, FactRegistrySchema, literals, validateFacts } from './facts.ts';
import { validateSite } from './semantic.ts';

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

  it("reads numbers as the business's country writes them, and never matches a number by its ending", () => {
    const facts = withFacts([
      fact('phone.us', 'phone', '(212) 555-0100'),
      fact('phone.uk', 'phone', '+442079460000'),
    ]);
    const say = (fr: string, country?: string) => {
      const spec = salon();
      if (country && spec.contact.address) spec.contact.address.country = country;
      hero(spec).subtitle = { fr, en: 'Call us' };
      return found(spec, facts);
    };
    const refused = ['unsupported_literal@pages.0.blocks.0.props.subtitle.fr'];
    // A US business writes US numbers nationally; the "(0)" style and a 00 prefix are read as international.
    expect(say('Appelez le +1 212 555 0100', 'US')).toEqual([]);
    expect(say('Appelez le +44 (0)20 7946 0000')).toEqual([]);
    expect(say('Appelez le 0044 20 7946 0000')).toEqual([]);
    expect(say('Appelez le 0590 00 01 01 ou le 590 00 01 01')).toEqual([]);
    // Another country code, a truncated number, or digits before the national number are other lines.
    expect(say('Appelez le +44 212 555 0100', 'US')).toEqual(refused);
    expect(say('Appelez le +1 312 212 555 0100', 'US')).toEqual(refused);
    expect(say('Appelez le 90 00 01 01')).toEqual(refused);
    expect(say('Appelez le +1 212 555 0100')).toEqual(refused);
    expect(say('Appelez le 0033 6 12 34 56 78', 'US')).toEqual(refused);
  });

  it('checks the contact phone in E.164 against a fact written nationally', () => {
    const spec = salon();
    if (spec.contact.phone) spec.contact.phone.value = '+590590000102';
    expect(found(spec)).toEqual(['fact_mismatch@contact.phone']);
    const national = {
      facts: registry().facts.map((f) => (f.kind === 'phone' ? { ...f, value: '0590 00 01 01' } : f)),
    };
    expect(found(salon(), national)).toEqual([]);
  });

  it('reads an address whole, before dates and years, and a spelled-out "(AT)" as "@"', () => {
    const spec = salon();
    hero(spec).subtitle = {
      fr: 'Écrivez à evil.com.1.1.2015@x.fr',
      en: 'Write to bonjour (AT) salon-lumiere.example',
    };
    expect(found(spec)).toEqual(['unsupported_literal@pages.0.blocks.0.props.subtitle.fr']);
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

  it.each([
    'Find us @ evil.com',
    'Find us (at) evil.com',
    'us  @  evil.com',
    'evil.com (at) a.bc',
    'web: evil.com (at) a.bc',
    'evil.com@a.bc',
  ])('refuses %j with one validator or the other (an address the web scan leaves is not a fact)', (text) => {
    const spec = salon();
    hero(spec).subtitle = { fr: text, en: 'Write to us' };
    const issues = [
      ...validateSite(spec, { assetHosts: ['assets.bf-sites.test'] }),
      ...validateFacts(spec, registry()),
    ].map((issue) => `${issue.code}@${issue.path.join('.')}`);
    expect(issues.filter((issue) => issue.endsWith('subtitle.fr'))).not.toEqual([]);
  });

  it.each([
    'Voir bonjour[@](page:home)evil.fr',
    'Voir [evil.com](page:home) @ x.fr',
    'Voir evil.com[(at)](page:home)x.fr',
    'Voir [evil.com @](page:home) x.fr',
  ])('refuses %j in rich text with one validator or the other', (body) => {
    const spec = salon();
    spec.pages[1]?.blocks.push({
      id: 'rich-serv7',
      type: 'rich_text',
      variant: 'narrow',
      props: { body: { fr: body, en: body } },
    });
    const issues = [
      ...validateSite(spec, { assetHosts: ['assets.bf-sites.test'] }),
      ...validateFacts(spec, registry()),
    ].map((issue) => `${issue.code}@${issue.path.join('.')}`);
    expect(issues.filter((issue) => issue.endsWith('props.body.fr'))).not.toEqual([]);
  });

  it('reads French-plan numbers on an overseas site, two numbers side by side, and no year in a phone', () => {
    const facts = withFacts([fact('phone.mobile', 'phone', '+33 6 12 34 56 78')]);
    const spec = salon();
    hero(spec).subtitle = {
      fr: 'Appelez le 06 12 34 56 78 ou le 0590 00 01 01 / 06 12 34 56 78',
      en: 'Call 0590-00-01-01',
    };
    expect(found(spec, facts)).toEqual([]);
  });

  it.each([
    'Appelez le 06 12 - 34 56 78',
    'Appelez le 0690 - 99 88 77',
    'Appelez le 0590 27 / 00 00',
    'Tél. 0690 – 12 34 56',
    'Appelez le 06 12 \u2014 34 56 78',
    'Appelez le 06 12 \u2010 34 56 78',
    'Appelez le 06 12 \u2011 34 56 78',
    'Appelez le 06 12 \u2212 34 56 78',
    'Appelez le 06\u00B712\u00B734\u00B756\u00B778',
    'Appelez le 06 12 | 34 56 78',
    'Appelez le 06 12 _ 34 56 78',
  ])('checks a number split by a separator as one number: %j', (subtitle) => {
    const spec = salon();
    hero(spec).subtitle = { fr: subtitle, en: 'Call us' };
    expect(found(spec)).toContain('unsupported_literal@pages.0.blocks.0.props.subtitle.fr');
  });

  it.each([
    'Ouvert 7j/7 • 0590 00 01 01',
    'Gustavia · 97133 · 0590 00 01 01',
    'Salon n°2 • 0590 00 01 01',
    'Pointures 36 · 38 · 40 · 42',
    'Tailles 36 • 38 • 40 • 42 • 44',
    'Formats 10 · 15 · 20 · 30 cm',
    'Ouvert 09 - 12 / 14 - 19',
    'Horaires 09 - 12 - 14 - 19',
    'Chambres 01 - 12 / 21 - 32',
    'Tailles 06 - 08 - 10 - 12 ans',
    'Suite 0101 - 0202',
  ])('reads bullets and number lists next to the real phone as prose: %j', (subtitle) => {
    const spec = salon();
    hero(spec).subtitle = { fr: subtitle, en: 'Welcome' };
    expect(found(spec).filter((issue) => issue.includes('subtitle'))).toEqual([]);
  });

  it.each([' '.repeat(40), '\n'.repeat(40), ' \t\n'.repeat(15)])(
    'checks a number split by a run of whitespace as one number (shown as one space): %j',
    (gap) => {
      const spec = salon();
      hero(spec).subtitle = { fr: `Appelez le 0690${gap}123456`, en: 'Call us' };
      expect(found(spec)).toContain('unsupported_literal@pages.0.blocks.0.props.subtitle.fr');
    },
  );

  it('still checks a year written beside the phone with a bullet', () => {
    const spec = salon();
    hero(spec).subtitle = { fr: 'Depuis 1952 · 0590 00 01 01', en: 'Welcome' };
    expect(validateFacts(spec, registry()).map((issue) => issue.message)).toEqual([
      'Remove the year 1952: it is not a fact.',
    ]);
  });

  it.each(['+33 590 00 01 01', '+596 590 00 01 01', '+262 590 00 01 01', '+594 590 00 01 01'])(
    'refuses the business’s number under another French-plan country code: %j',
    (number) => {
      const spec = salon();
      hero(spec).subtitle = { fr: `Appelez le ${number}`, en: 'Call us' };
      expect(found(spec)).toContain('unsupported_literal@pages.0.blocks.0.props.subtitle.fr');
    },
  );

  it('reads spaced parts as a phone when they make a possible number in the site’s country', () => {
    const bl = salon();
    hero(bl).subtitle = { fr: 'Appelez le 690 - 12 - 34 - 56', en: 'Call us' };
    expect(found(bl)).toContain('unsupported_literal@pages.0.blocks.0.props.subtitle.fr');
    const us = salon();
    if (us.contact.address) us.contact.address.country = 'US';
    hero(us).subtitle = { fr: 'Appelez le 212 - 555 - 0100', en: 'Call us' };
    expect(found(us)).toContain('unsupported_literal@pages.0.blocks.0.props.subtitle.fr');
  });

  it.each([
    'Ouvert 10 - 12 / 14 - 19',
    'Tailles 36 - 38 - 40 - 42',
    'Groupes de 10 - 15 / 20 - 30 personnes',
    'Ages 3 - 6 / 7 - 12 / 13 - 17',
    'Chambres 101 - 112 / 201 - 212',
    'Villas de 1 500 - 2 000 m²',
  ])('reads ranges of numbers in prose as prose, not phones: %j', (subtitle) => {
    const spec = salon();
    hero(spec).subtitle = { fr: subtitle, en: 'Welcome' };
    expect(found(spec).filter((issue) => issue.includes('subtitle'))).toEqual([]);
  });

  it.each([
    ['MQ', '+596 598 12 34 56', '0598 12 34 56'],
    ['GF', '+594 598 12 34 56', '0598 12 34 56'],
    ['MQ', '+596 709 12 34 56', '0709 12 34 56'],
    ['BL', '+590 976 12 34 56', '0976 12 34 56'],
    ['RE', '+262 268 12 34 56', '0268 12 34 56'],
    ['YT', '+262 269 61 23 45', '0269 61 23 45'],
  ])('reads a shared French-plan range on a %s site as dialled in France', (country, fact_, text) => {
    const facts = withFacts([fact('phone.other', 'phone', fact_)]);
    const spec = salon();
    if (spec.contact.address) spec.contact.address.country = country;
    hero(spec).subtitle = { fr: `Appelez le ${text}`, en: 'Call us' };
    expect(found(spec, facts).filter((issue) => issue.includes('subtitle'))).toEqual([]);
  });

  it('reads a French-plan number as dialled in France, not by the site’s country', () => {
    // Martinique on a BL site, Guadeloupe on a mainland site: both are the facts they name.
    const martinique = withFacts([fact('phone.mq', 'phone', '+596 696 12 34 56')]);
    const bl = salon();
    hero(bl).subtitle = { fr: 'Appelez le 0696 12 34 56', en: 'Call +596 696 12 34 56' };
    expect(found(bl, martinique)).toEqual([]);
    const guadeloupe = withFacts([fact('phone.gp', 'phone', '+590 690 12 34 56')]);
    const mainland = salon();
    if (mainland.contact.address) mainland.contact.address.country = 'FR';
    hero(mainland).subtitle = { fr: 'Appelez le 0690 12 34 56', en: 'Call 0690 12 34 56' };
    expect(found(mainland, guadeloupe).filter((issue) => issue.includes('subtitle'))).toEqual([]);
    // Another Martinique number is not the fact.
    const other = salon();
    hero(other).subtitle = { fr: 'Appelez le 0696 12 34 57', en: 'Call us' };
    expect(found(other, martinique)).toContain('unsupported_literal@pages.0.blocks.0.props.subtitle.fr');
  });

  it('quotes a review with its emoji, with or without the presentation selector', () => {
    const facts = {
      facts: registry().facts.map((f) =>
        f.id === 'review.1'
          ? { ...f, value: { ...(f.value as object), quote: 'Coupe parfaite, merci \u2764\uFE0F' } }
          : f,
      ),
    };
    for (const quote of ['Coupe parfaite, merci \u2764\uFE0F', 'Coupe parfaite, merci \u2764']) {
      const spec = salon();
      testimonial(spec).quote.fr = quote;
      expect(found(spec, facts as FactRegistry)).toEqual([]);
    }
  });

  it('still checks a year or number written next to a phone number', () => {
    const spec = salon();
    hero(spec).subtitle = {
      fr: 'Depuis 1987 - 0590 00 01 01',
      en: '0590 00 01 01 / 99 et 0590 00 01 01 - 1987',
    };
    expect(validateFacts(spec, registry()).map((issue) => issue.message)).toEqual([
      'Remove the year 1987: it is not a fact.',
      'Remove the year 1987: it is not a fact.',
    ]);
  });

  it('compares digits exactly without an address country', () => {
    const spec = salon();
    spec.contact.address = undefined;
    if (spec.contact.phone) spec.contact.phone.value = '+33590000101';
    const national = {
      facts: registry().facts.map((f) => (f.kind === 'phone' ? { ...f, value: '05 90 00 01 01' } : f)),
    };
    expect(found(spec, national)).toContain('fact_mismatch@contact.phone');
  });

  it('reads a long run of spaces between digits quickly (no quadratic split)', () => {
    const spec = salon();
    const body = `1${' '.repeat(4998)}1`;
    for (let n = 0; n < 20; n += 1)
      spec.pages[1]?.blocks.push({
        id: `rich-slow${n}`,
        type: 'rich_text',
        variant: 'narrow',
        props: { body: { fr: body, en: body } },
      });
    const started = performance.now();
    validateFacts(spec, registry());
    expect(performance.now() - started).toBeLessThan(500);
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
