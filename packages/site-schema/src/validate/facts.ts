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
  'legal_id',
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
      'legal_id',
      'other',
    ]),
    value: text,
  }),
]);
export type Fact = z.infer<typeof FactSchema>;
type FactOf<K extends Fact['kind']> =
  Extract<Fact, { kind: K }> extends never ? Fact & { kind: K; value: string } : Extract<Fact, { kind: K }>;

export const FactRegistrySchema = z
  .object({ facts: z.array(FactSchema).max(2000) })
  .strict()
  .refine((registry) => new Set(registry.facts.map((fact) => fact.id)).size === registry.facts.length, {
    message: 'Fact ids are unique',
  });
export type FactRegistry = z.infer<typeof FactRegistrySchema>;

const digits = (value: string) => value.normalize('NFKC').replace(/\D/g, '');
/** For comparing texts: compatibility forms, case, spacing and punctuation folded. */
const norm = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
/** The national number: the last 9 digits (country code and trunk 0 dropped; FR, BL and most of Europe). */
const national = (value: string) => digits(value).slice(-9);

const CURRENCY = String.raw`€|\$|£|\bEUR\b|\bUSD\b|\bGBP\b|\beuros?\b|\bdollars?\b|\blivres?\b`;
const AMOUNT = String.raw`\d{1,3}(?:[   .,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const PRICE = new RegExp(`(?:(${CURRENCY})\\s?(${AMOUNT}))|(?:(${AMOUNT})\\s?(${CURRENCY}))`, 'giu');
const YEAR_RANGE = /\b(1[89]\d{2}|20\d{2})\s*[-–]\s*(1[89]\d{2}|20\d{2})\b/g;
const PHONE = /\(?\+?\d[\d\s\u00A0\u202F()./-]{6,}\d/g;
const EMAIL_LITERAL = /[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){1,10}/gu;
const YEAR = /\b(1[89]\d{2}|20\d{2})\b(?!\s?(?:m²|m2|m\b|km|€|\$|%|h\b))/g;

const currencyOf = (mark: string) => {
  const m = mark.toLowerCase();
  if (m === '€' || m.startsWith('eur')) return 'EUR';
  if (m === '$' || m === 'usd' || m.startsWith('dollar')) return 'USD';
  return 'GBP';
};

/** "1 250,00", "1.250", "1,250", "12,50" → a number (a separator before 3 digits groups, before 1–2 is decimal). */
function amountOf(text: string): number {
  const match = /^(.*?)(?:[.,](\d{1,2}))?$/.exec(text.replace(/[   ]/g, ''));
  const whole = (match?.[1] ?? text).replace(/[.,]/g, '');
  return Number(`${whole}.${match?.[2] ?? '0'}`);
}

export interface Literals {
  readonly phones: string[];
  readonly emails: string[];
  readonly prices: { readonly amount: number; readonly currency: string; readonly text: string }[];
  readonly years: number[];
}

/**
 * Phone numbers (8+ digits; spaces, dots, dashes, slashes and brackets allowed), e-mail addresses, prices (a currency
 * mark or word; thousands separators of FR and EN) and years in a text. A span counts once: prices first, then year
 * ranges, phones, years.
 */
export function literals(input: string): Literals {
  let text = input.normalize('NFKC');
  const blank = (match: string) => ' '.repeat(match.length);
  const prices: Literals['prices'] = [];
  text = text.replace(
    PRICE,
    (
      match,
      mark1: string | undefined,
      amount1: string | undefined,
      amount2: string | undefined,
      mark2: string | undefined,
    ) => {
      prices.push({
        amount: amountOf(amount1 ?? amount2 ?? ''),
        currency: currencyOf(mark1 ?? mark2 ?? ''),
        text: match.trim(),
      });
      return blank(match);
    },
  );
  const years: number[] = [];
  text = text.replace(YEAR_RANGE, (match, from: string, to: string) => {
    years.push(Number(from), Number(to));
    return blank(match);
  });
  const emails: string[] = [];
  text = text.replace(EMAIL_LITERAL, (match) => {
    emails.push(match);
    return blank(match);
  });
  const phones: string[] = [];
  text = text.replace(PHONE, (match) => {
    if (digits(match).length < 8) return match;
    phones.push(match.trim());
    return blank(match);
  });
  for (const match of text.matchAll(YEAR)) years.push(Number(match[1]));
  return { phones, emails, prices, years };
}

/** Strings of the spec that are text (not ids, URLs, colours or references), outside the fact-checked contact. */
const NOT_TEXT_KEYS = new Set([
  'id',
  'pageId',
  'factId',
  'url',
  'type',
  'variant',
  'kind',
  'network',
  'country',
  'currency',
]);
const NOT_TEXT_ROOTS = new Set([
  'contact',
  'brand',
  'theme',
  'settings',
  'schemaVersion',
  'locales',
  'defaultLocale',
]);

function* texts(spec: SiteSpec): Generator<{ text: string; path: Path }> {
  for (const { value, path, key } of walk(spec)) {
    if (typeof value !== 'string' || NOT_TEXT_ROOTS.has(String(path[0]))) continue;
    if (NOT_TEXT_KEYS.has(String(key)) || String(key).endsWith('AssetId')) continue;
    const parent = String(path.at(-2));
    if (parent === 'factIds' || parent === 'assetIds') continue;
    yield { text: value, path };
  }
}

export function validateFacts(spec: SiteSpec, registry: FactRegistry): Issue[] {
  const issues: Issue[] = [];
  const facts = new Map(registry.facts.map((fact) => [fact.id, fact]));
  const of = <K extends FactKind>(kind: K) =>
    registry.facts.filter((fact) => fact.kind === kind) as FactOf<K>[];

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
    (f) => norm(f.value) === norm(brand.name),
    'the business name',
  );
  if (contact.phone)
    check(
      ['contact', 'phone'],
      contact.phone.factId,
      ['phone'],
      (f) => national(f.value) === national(contact.phone?.value ?? ''),
      'the phone number',
    );
  if (contact.whatsapp)
    check(
      ['contact', 'whatsapp'],
      contact.whatsapp.factId,
      ['whatsapp', 'phone'],
      (f) => national(f.value) === national(contact.whatsapp?.value ?? ''),
      'the WhatsApp number',
    );
  if (contact.email)
    check(
      ['contact', 'email'],
      contact.email.factId,
      ['email'],
      (f) => norm(f.value) === norm(contact.email?.value ?? ''),
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
    check(
      ['contact', 'address'],
      contact.address.factId,
      ['address'],
      (f) => norm(f.value) === norm(contact.address?.formatted ?? ''),
      'the address',
    );
  // DECISION(BF-033): hours facts are free text in the registry's first version (BF-040): checked by kind only.
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

  // Testimonials and team members by their place in the blocks (an item without an author is still checked).
  for (const [i, page] of spec.pages.entries()) {
    for (const [j, block] of page.blocks.entries()) {
      const at = (...rest: (string | number)[]) => ['pages', i, 'blocks', j, 'props', ...rest];
      if (block.type === 'testimonials') {
        for (const [n, item] of block.props.items.entries()) {
          check(
            at('items', n),
            item.factId,
            ['testimonial'],
            (f) => {
              const quote = f.locale
                ? item.quote[f.locale]
                : Object.values(item.quote).find((text) => norm(text ?? '') === norm(f.value.quote));
              return (
                norm(quote ?? '') === norm(f.value.quote) &&
                (item.author === undefined || norm(item.author) === norm(f.value.author)) &&
                (item.rating === undefined || item.rating === f.value.rating)
              );
            },
            'the testimonial (its quote in its language, its author and rating)',
          );
        }
      }
      if (block.type === 'team') {
        for (const [n, member] of block.props.members.entries()) {
          check(
            at('members', n),
            member.factId,
            ['team_member'],
            (f) => norm(f.value.name) === norm(member.name),
            'the team member',
          );
        }
      }
    }
  }

  // Prices state their facts' amounts and currencies.
  for (const { value, path } of walk(spec.pages)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (
      typeof record.amount === 'number' &&
      typeof record.currency === 'string' &&
      typeof record.factId === 'string'
    ) {
      check(
        ['pages', ...path],
        record.factId,
        ['price'],
        (f) => f.value.amount === record.amount && f.value.currency === record.currency,
        'the price',
      );
    }
  }

  // Literal values in any text must be facts (or appear in a fact's own text: a legal id, a share capital).
  const phones = [...of('phone'), ...of('whatsapp')].map((f) => national(f.value));
  const emails = of('email').map((f) => norm(f.value));
  const prices = of('price').map((f) => f.value);
  const years = of('year').map((f) => f.value);
  const factText = registry.facts
    .filter((fact) => typeof fact.value === 'string')
    .map((fact) => digits(String(fact.value)))
    .join(' ');
  const inFactText = (number: string) => number.length > 0 && factText.includes(number);
  for (const { text, path } of texts(spec)) {
    const found = literals(text);
    for (const phone of found.phones) {
      if (!phones.includes(national(phone)) && !inFactText(digits(phone)))
        issues.push(
          error(path, 'unsupported_literal', `Remove the phone number "${phone}" or use the contact facts.`),
        );
    }
    for (const email of found.emails) {
      if (!emails.includes(norm(email)))
        issues.push(
          error(path, 'unsupported_literal', `Remove the e-mail address "${email}": it is not a fact.`),
        );
    }
    for (const price of found.prices) {
      const known = prices.some((p) => p.amount === price.amount && p.currency === price.currency);
      if (!known && !inFactText(digits(String(price.amount))))
        issues.push(
          error(
            path,
            'unsupported_literal',
            `Remove the price "${price.text}": only published prices (facts) may appear.`,
          ),
        );
    }
    for (const year of found.years) {
      if (!years.includes(year) && !inFactText(String(year)))
        issues.push(error(path, 'unsupported_literal', `Remove the year ${year}: it is not a fact.`));
    }
  }
  return issues;
}
