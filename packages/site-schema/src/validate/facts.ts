import { z } from 'zod';
import { FactIdSchema, SiteLocaleSchema } from '../spec/localized.ts';
import type { SiteSpec } from '../spec/site.ts';
import { error, type Issue } from './issues.ts';
import { isLocalized, type Path, walk } from './walk.ts';

// The facts validator (BF-033): a site may only state what the fact registry (BF-040) holds. Every fact id it names
// must exist and be of the right kind, contact values and prices must equal their facts, and phone numbers,
// e-mail addresses, prices and years written in free text must match a fact — else they are invented.

export const FACT_KINDS = [
  'business_name',
  'phone',
  'email',
  'whatsapp',
  'address',
  'geo',
  'hours',
  'social',
  'booking_url',
  'service',
  'price',
  'menu_item',
  'testimonial',
  'team_member',
  'year',
  'award',
  'other',
] as const;
export type FactKind = (typeof FACT_KINDS)[number];

const text = z.string().min(1).max(2000);

const factBase = {
  id: FactIdSchema,
  locale: SiteLocaleSchema.optional().describe('The language the value is written in, when it is text.'),
  source: z.string().min(1).max(200).describe('Where it was read: "website", "google_places", "owner"…'),
  confidence: z.number().min(0).max(1),
};

/** A verified fact: what it says (typed by kind), where it was read, how sure we are. */
export const FactSchema = z.discriminatedUnion('kind', [
  z.object({
    ...factBase,
    kind: z.literal('price'),
    value: z.object({ amount: z.number().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) }),
  }),
  z.object({ ...factBase, kind: z.literal('year'), value: z.number().int().min(1000).max(2100) }),
  z.object({ ...factBase, kind: z.literal('geo'), value: z.object({ lat: z.number(), lng: z.number() }) }),
  z.object({
    ...factBase,
    kind: z.literal('testimonial'),
    value: z.object({
      quote: text,
      author: z.string().min(1).max(60),
      rating: z.number().int().min(1).max(5).optional(),
    }),
  }),
  z.object({
    ...factBase,
    kind: z.literal('team_member'),
    value: z.object({ name: z.string().min(1).max(60), role: z.string().max(80).optional() }),
  }),
  z.object({
    ...factBase,
    kind: z.enum([
      'business_name',
      'phone',
      'email',
      'whatsapp',
      'address',
      'hours',
      'social',
      'booking_url',
      'service',
      'menu_item',
      'award',
      'other',
    ]),
    value: text,
  }),
]);
export type Fact = z.infer<typeof FactSchema>;
type FactOf<K extends Fact['kind']> =
  Extract<Fact, { kind: K }> extends never ? Fact & { kind: K; value: string } : Extract<Fact, { kind: K }>;

export const FactRegistrySchema = z.object({ facts: z.array(FactSchema).max(2000) }).strict();
export type FactRegistry = z.infer<typeof FactRegistrySchema>;

const digits = (value: string) => value.replace(/\D/g, '');
const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Phone-like runs of 8+ digits (spaces, dots and dashes allowed), e-mail addresses, prices and years in a text. */
export function literals(textValue: string): {
  phones: string[];
  emails: string[];
  prices: number[];
  years: number[];
} {
  const phones = [...textValue.matchAll(/\+?\d[\d .-]{6,}\d/g)]
    .map((m) => m[0])
    .filter((m) => digits(m).length >= 8);
  const emails = [...textValue.matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)].map((m) => m[0]);
  const prices = [
    ...textValue.matchAll(
      /(?:€|\$|£|EUR|USD|GBP)\s?(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s?(?:€|\$|£|EUR|USD|GBP)/g,
    ),
  ].map((m) => Number((m[1] ?? m[2] ?? '').replace(',', '.')));
  const years = [...textValue.matchAll(/\b(1[89]\d{2}|20\d{2})\b/g)].map((m) => Number(m[1]));
  return { phones, emails, prices, years };
}

export function validateFacts(spec: SiteSpec, registry: FactRegistry): Issue[] {
  const issues: Issue[] = [];
  const facts = new Map(registry.facts.map((fact) => [fact.id, fact]));
  const of = (kind: FactKind) => registry.facts.filter((fact) => fact.kind === kind);

  // Every named fact exists.
  for (const { value, path, key } of walk(spec)) {
    if (key === 'factId' && typeof value === 'string' && !facts.has(value)) {
      issues.push(error(path, 'fact_unknown', `Use a fact from the registry: there is no fact "${value}".`));
    }
    if (key === 'factIds' && Array.isArray(value)) {
      for (const [i, id] of value.entries()) {
        if (typeof id === 'string' && !facts.has(id))
          issues.push(error([...path, i], 'fact_unknown', `Remove "${id}": there is no such fact.`));
      }
    }
  }

  /** The fact behind a value: of the expected kind, its value checked by `same`. */
  const check = <K extends FactKind>(
    path: Path,
    factId: string | undefined,
    kinds: readonly K[],
    same: (fact: FactOf<K>) => boolean,
    what: string,
  ) => {
    if (!factId) return;
    const fact = facts.get(factId);
    if (!fact) return;
    if (!(kinds as readonly string[]).includes(fact.kind)) {
      issues.push(
        error(
          [...path, 'factId'],
          'fact_kind',
          `Use a ${kinds.join(' or ')} fact for ${what} ("${factId}" is a ${fact.kind}).`,
        ),
      );
    } else if (!same(fact as FactOf<K>)) {
      issues.push(error(path, 'fact_mismatch', `Write ${what} exactly as fact "${factId}" states it.`));
    }
  };

  const { contact, brand } = spec;
  check(
    ['brand'],
    brand.factId,
    ['business_name'],
    (f) => sameText(f.value, brand.name),
    'the business name',
  );
  if (contact.phone)
    check(
      ['contact', 'phone'],
      contact.phone.factId,
      ['phone'],
      (f) => digits(f.value) === digits(contact.phone?.value ?? ''),
      'the phone number',
    );
  if (contact.whatsapp)
    check(
      ['contact', 'whatsapp'],
      contact.whatsapp.factId,
      ['whatsapp', 'phone'],
      (f) => digits(f.value) === digits(contact.whatsapp?.value ?? ''),
      'the WhatsApp number',
    );
  if (contact.email)
    check(
      ['contact', 'email'],
      contact.email.factId,
      ['email'],
      (f) => sameText(f.value, contact.email?.value ?? ''),
      'the e-mail address',
    );
  if (contact.bookingUrl)
    check(
      ['contact', 'bookingUrl'],
      contact.bookingUrl.factId,
      ['booking_url'],
      (f) => f.value === contact.bookingUrl?.value,
      'the booking page',
    );
  if (contact.address)
    check(['contact', 'address'], contact.address.factId, ['address'], () => true, 'the address');
  if (contact.hours)
    check(['contact', 'hours'], contact.hours.factId, ['hours'], () => true, 'the opening hours');
  if (contact.geo)
    check(
      ['contact', 'geo'],
      contact.geo.factId,
      ['geo'],
      (f) =>
        Math.abs(f.value.lat - (contact.geo?.lat ?? 0)) < 1e-4 &&
        Math.abs(f.value.lng - (contact.geo?.lng ?? 0)) < 1e-4,
      'the coordinates',
    );
  for (const [i, social] of (contact.socials ?? []).entries()) {
    check(
      ['contact', 'socials', i],
      social.factId,
      ['social'],
      (f) => f.value === social.url,
      'the profile URL',
    );
  }

  // Prices, testimonials and team members state their facts' values.
  for (const { value, path } of walk(spec.pages)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const at = ['pages', ...path];
    if (
      typeof record.amount === 'number' &&
      typeof record.currency === 'string' &&
      typeof record.factId === 'string'
    ) {
      check(
        at,
        record.factId,
        ['price'],
        (f) => f.value.amount === record.amount && f.value.currency === record.currency,
        'the price',
      );
    }
    if (
      typeof record.quote === 'object' &&
      typeof record.author === 'string' &&
      typeof record.factId === 'string'
    ) {
      check(
        at,
        record.factId,
        ['testimonial'],
        (f) =>
          sameText(f.value.author, record.author as string) &&
          (record.rating === undefined || f.value.rating === record.rating),
        'the testimonial',
      );
    }
    if (typeof record.name === 'string' && typeof record.factId === 'string' && !('quote' in record)) {
      check(
        at,
        record.factId,
        ['team_member'],
        (f) => sameText(f.value.name, record.name as string),
        'the team member',
      );
    }
  }

  // Literal values in free text must be facts.
  const phones = [...of('phone'), ...of('whatsapp')].map((f) => digits(String(f.value)));
  const emails = of('email').map((f) => String(f.value).toLowerCase());
  const prices = of('price').map((f) => (f as FactOf<'price'>).value.amount);
  const years = of('year').map((f) => (f as FactOf<'year'>).value);
  for (const { value, path } of walk(spec.pages)) {
    if (!isLocalized(value)) continue;
    for (const [locale, textValue] of Object.entries(value)) {
      const found = literals(textValue ?? '');
      const at = ['pages', ...path, locale];
      for (const phone of found.phones) {
        if (!phones.some((known) => known.endsWith(digits(phone)) || digits(phone).endsWith(known)))
          issues.push(
            error(at, 'unsupported_literal', `Remove the phone number "${phone}" or use the contact facts.`),
          );
      }
      for (const email of found.emails) {
        if (!emails.includes(email.toLowerCase()))
          issues.push(
            error(at, 'unsupported_literal', `Remove the e-mail address "${email}": it is not a fact.`),
          );
      }
      for (const price of found.prices) {
        if (!prices.includes(price))
          issues.push(
            error(
              at,
              'unsupported_literal',
              `Remove the price ${price}: only published prices (facts) may appear.`,
            ),
          );
      }
      for (const year of found.years) {
        if (!years.includes(year))
          issues.push(error(at, 'unsupported_literal', `Remove the year ${year}: it is not a fact.`));
      }
    }
  }
  return issues;
}
