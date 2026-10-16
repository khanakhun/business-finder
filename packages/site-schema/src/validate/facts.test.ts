import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SiteSpec } from '../spec/site.ts';
import { type FactRegistry, FactRegistrySchema, literals, validateFacts } from './facts.ts';

const read = (path: string) =>
  JSON.parse(readFileSync(new URL(`../../fixtures/${path}`, import.meta.url), 'utf8'));
const salon = (): SiteSpec => read('salon-gustavia.json');
const registry = (): FactRegistry => FactRegistrySchema.parse(read('facts/salon-gustavia.json'));
const found = (spec: SiteSpec, facts = registry()) =>
  validateFacts(spec, facts).map((issue) => `${issue.code}@${issue.path.join('.')}`);
const hero = (spec: SiteSpec) => {
  const block = spec.pages[0]?.blocks[0];
  if (block?.type !== 'hero') throw new Error('no hero');
  return block.props;
};

describe('validateFacts', () => {
  it('accepts a site that states only its facts', () => {
    expect(found(salon())).toEqual([]);
  });

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

  it('checks the kind and the value of contact facts', () => {
    const spec = salon();
    if (spec.contact.phone) spec.contact.phone.value = '+590590999999';
    if (spec.contact.email) spec.contact.email.factId = 'phone.main';
    spec.brand.name = 'Salon Soleil';
    expect(found(spec)).toEqual([
      'fact_mismatch@brand',
      'fact_mismatch@contact.phone',
      'fact_kind@contact.email.factId',
    ]);
  });

  it('checks prices, testimonials and team members against their facts', () => {
    const spec = salon();
    const services = spec.pages[0]?.blocks[2];
    if (services?.type === 'services' && services.props.items[0]?.price)
      services.props.items[0].price.amount = 55;
    const testimonials = spec.pages[0]?.blocks[3];
    if (testimonials?.type === 'testimonials' && testimonials.props.items[0])
      testimonials.props.items[0].author = 'Anne B.';
    spec.pages[0]?.blocks.push({
      id: 'team-home9',
      type: 'team',
      variant: 'grid',
      props: { members: [{ factId: 'review.1', name: 'Claire D.' }] },
    });
    expect(found(spec)).toEqual([
      'fact_mismatch@pages.0.blocks.2.props.items.0.price',
      'fact_mismatch@pages.0.blocks.3.props.items.0',
      'fact_kind@pages.0.blocks.5.props.members.0.factId',
    ]);
  });

  it('refuses phone numbers, e-mails, prices and years in text that no fact holds', () => {
    const spec = salon();
    hero(spec).subtitle = {
      fr: 'Depuis 2015, appelez le 0590 00 01 01, une coupe dès 65 €.',
      en: 'Since 1998, call +590 590 12 34 56 or write to hello@elsewhere.example, cuts from €35.',
    };
    expect(validateFacts(spec, registry()).map((issue) => issue.message)).toEqual([
      'Remove the phone number "+590 590 12 34 56" or use the contact facts.',
      'Remove the e-mail address "hello@elsewhere.example": it is not a fact.',
      'Remove the price 35: only published prices (facts) may appear.',
      'Remove the year 1998: it is not a fact.',
    ]);
  });

  it('finds literals in text', () => {
    expect(literals('Call 05 90 27 00 00 or +33 2 97 00 03 03, €12,50, 7 € and 2024')).toEqual({
      phones: ['05 90 27 00 00', '+33 2 97 00 03 03'],
      emails: [],
      prices: [12.5, 7],
      years: [2024],
    });
    expect(literals('Open 9 to 18, 3 rooms')).toEqual({ phones: [], emails: [], prices: [], years: [] });
  });
});
