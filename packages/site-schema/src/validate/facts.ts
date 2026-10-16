import { type CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { z } from 'zod';
import { FactIdSchema, SiteLocaleSchema } from '../spec/localized.ts';
import type { SiteSpec } from '../spec/site.ts';
import { emailPattern, unspell } from './email.ts';
import { error, type Issue } from './issues.ts';
import { richTextWords } from './rich-text.ts';
import { type Path, walk } from './walk.ts';

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
/** For comparing e-mail addresses: compatibility forms and case folded, nothing else (`jean.dupont` ≠ `jean@dupont`). */
const mailbox = (value: string) => value.normalize('NFKC').trim().toLowerCase();
/** A number as dialled: digits only, a `(0)` after the country code dropped (`+44 (0)20…`), no `00` prefix. */
const dialled = (raw: string) =>
  digits(raw.normalize('NFKC').replace(/^(\s*(?:\+|00)\s*\d{1,3}\s*)\(\s*0\s*\)/, '$1')).replace(/^00/, '');

/** A number in E.164, read as the business's country writes it (national formats, `(0)`, `00`); else undefined. */
function e164(raw: string, country: string | undefined): string | undefined {
  const text = raw.normalize('NFKC');
  const parsed = parsePhoneNumberFromString(text, country as CountryCode | undefined);
  if (parsed?.isValid()) return parsed.number;
  // France and its overseas departments share one numbering plan: a mainland mobile (`06…`) on a BL site is French.
  if (country && FRENCH_PLAN.includes(country)) {
    for (const other of FRENCH_PLAN) {
      const candidate = parsePhoneNumberFromString(text, other as CountryCode);
      if (candidate?.isValid()) return candidate.number;
    }
  }
  return parsed?.isPossible() ? parsed.number : undefined;
}

const FRENCH_PLAN = ['FR', 'GP', 'BL', 'MF', 'MQ', 'GF', 'RE', 'YT', 'PM'];

/**
 * Two phone numbers are the same line: the same E.164 number once read as the business's country writes numbers
 * (`0590 00 01 01` and `+590 590 00 01 01` in BL; `(212) 555-0100` and `+1 212 555 0100` in the US), else the same
 * digits. Nothing matches by its ending: `90 00 01 01` or a number under another country code is another line.
 */
function samePhone(a: string, b: string, country: string | undefined): boolean {
  const [ea, eb] = [e164(a, country), e164(b, country)];
  if (ea !== undefined && eb !== undefined) return ea === eb;
  return dialled(a) === dialled(b);
}

const CURRENCY = String.raw`€|\$|£|\bEUR\b|\bUSD\b|\bGBP\b|\bCHF\b|\beuros?\b|\bdollars?\b|\blivres? sterling\b|\bfrancs?\b`;
const AMOUNT = String.raw`\d{1,3}(?:[   .,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const PRICE = new RegExp(`(?:(${CURRENCY})\\s{0,3}(${AMOUNT}))|(?:(${AMOUNT})\\s{0,3}(${CURRENCY}))`, 'giu');
const YEAR_RANGE = /\b(1[89]\d{2}|20\d{2})\s*[-–]\s*(1[89]\d{2}|20\d{2})\b/g;
/** A phone-like run (bounded: a long run is read as several, each refused unless a fact). */
const PHONE = /\(?\+?\d[\d\s\u00A0\u202F()./-]{6,30}\d/g;
/** The separator of two numbers side by side (`0590 27 00 00 / 0690 12 34 56`), kept by `split`. */
const PAIR = /([ \u00A0\u202F]{1,3}[/–-][ \u00A0\u202F]{1,3})/;
const YEAR = /\b(1[89]\d{2}|20\d{2})\b(?!\s?(?:m²|m2|m\b|km|€|\$|%|h\b))/g;

const currencyOf = (mark: string) => {
  const m = mark.toLowerCase();
  if (m === '€' || m.startsWith('eur')) return 'EUR';
  if (m === '$' || m === 'usd' || m.startsWith('dollar')) return 'USD';
  if (m === 'chf' || m.startsWith('franc')) return 'CHF';
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
  // E-mails first: a date, a year range or a price inside an address must not cut it apart.
  const emails: string[] = [];
  text = text.replace(emailPattern(), (match) => {
    emails.push(match);
    return blank(match);
  });
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
  // Dates (dd/mm/yyyy, yyyy-mm-dd) are not phone numbers: their year is checked.
  text = text.replace(
    /\b(?:\d{1,2}[/.-]\d{1,2}[/.-]((?:1[89]|20)\d{2})|((?:1[89]|20)\d{2})-\d{1,2}-\d{1,2})\b/g,
    (match, y1: string | undefined, y2: string | undefined) => {
      years.push(Number(y1 ?? y2));
      return blank(match);
    },
  );
  const phones: string[] = [];
  // Two numbers side by side are two literals; a shorter part (`Depuis 1987 - 0590…`) stays in the text, so its year
  // or number is still checked.
  text = text.replace(PHONE, (match) =>
    match
      .split(PAIR)
      .map((part, i) => {
        if (i % 2 === 1 || digits(part).length < 8) return part;
        phones.push(part.trim());
        return blank(part);
      })
      .join(''),
  );
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
    if (typeof value !== 'string') continue;
    // The contact facts are compared to their facts; only the hours note is free text.
    const note = path[0] === 'contact' && path[1] === 'hours' && path[2] === 'note';
    if (NOT_TEXT_ROOTS.has(String(path[0])) && !note) continue;
    if (NOT_TEXT_KEYS.has(String(key)) || String(key).endsWith('AssetId')) continue;
    const parent = String(path.at(-2));
    if (parent === 'factIds' || parent === 'assetIds') continue;
    // Rich text as the reader sees it (`bonjour[@](page:home)evil.fr` reads `bonjour@evil.fr`).
    const [pages, i, blocks, j, props, body] = path;
    const rich =
      pages === 'pages' &&
      blocks === 'blocks' &&
      props === 'props' &&
      body === 'body' &&
      spec.pages[Number(i)]?.blocks[Number(j)]?.type === 'rich_text';
    yield { text: rich ? richTextWords(value) : value, path };
  }
}

export function validateFacts(spec: SiteSpec, registry: FactRegistry): Issue[] {
  const issues: Issue[] = [];
  const facts = new Map(registry.facts.map((fact) => [fact.id, fact]));
  // Numbers are read as the business's country writes them (its address); without one, digits must be equal.
  // DECISION(BF-033): a phone fact written nationally (`05 90 00 01 01`) is read with the site's address country, which
  // the spec states; a wrong country would only give another valid E.164. The registry builder (BF-040) stores phone
  // facts in E.164 so the comparison never depends on the spec.
  const country = spec.contact.address?.country;
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
      (f) => samePhone(f.value, contact.phone?.value ?? '', country),
      'the phone number',
    );
  if (contact.whatsapp)
    check(
      ['contact', 'whatsapp'],
      contact.whatsapp.factId,
      ['whatsapp', 'phone'],
      (f) => samePhone(f.value, contact.whatsapp?.value ?? '', country),
      'the WhatsApp number',
    );
  if (contact.email)
    check(
      ['contact', 'email'],
      contact.email.factId,
      ['email'],
      (f) => mailbox(f.value) === mailbox(contact.email?.value ?? ''),
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
  const addressFact = contact.address ? facts.get(contact.address.factId) : undefined;
  if (contact.address && addressFact?.kind === 'address') {
    for (const part of ['street', 'postalCode', 'locality', 'region'] as const) {
      const value = contact.address[part];
      // Whole words: `2 rue du Port` is not in `12 rue du Port`.
      if (value && !` ${norm(addressFact.value)} `.includes(` ${norm(value)} `)) {
        issues.push(
          error(
            ['contact', 'address', part],
            'fact_mismatch',
            `Write the ${part} as the address fact states it.`,
          ),
        );
      }
    }
  }
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
            // DECISION(BF-033): a role matches when one of its languages states the fact's role. Role facts are in one
            // language, so the other languages (translations) cannot be checked; BF-034 shows them as translations.
            (f) =>
              norm(f.value.name) === norm(member.name) &&
              (f.value.role === undefined ||
                member.role === undefined ||
                Object.values(member.role).some((role) => norm(role ?? '') === norm(f.value.role ?? ''))),
            'the team member (name and role)',
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
  const phones = [...of('phone'), ...of('whatsapp')].map((f) => f.value);
  const emails = of('email').map((f) => mailbox(f.value));
  const prices = of('price').map((f) => f.value);
  const years = of('year').map((f) => f.value);
  // Numbers a fact states in its own text (a legal notice's SIRET, a share capital, an award's year): whole numbers
  // only, and only from the kinds that state numbers in prose — never a phone, address or hours fact's digits.
  const stating = registry.facts.filter((fact) => ['legal_id', 'award', 'other'].includes(fact.kind));
  const stated = stating.map((fact) => ({ text: String(fact.value), found: literals(String(fact.value)) }));
  const statedNumbers = new Set(
    stated.flatMap(({ text, found }) => [
      ...[...text.normalize('NFKC').matchAll(/\d+(?:[ \u00A0\u202F.,]\d+)*/g)].map((m) => digits(m[0])),
      // Ids written like phone numbers (`RCS 123-456-789`, `N° 12/345/678`) match whole.
      ...found.phones.map(digits),
    ]),
  );
  // Years only from what the facts state as years (`1 800 clients` is not the year 1800).
  const statedYears = new Set(stated.flatMap(({ found }) => found.years));
  const statedPrices = stated.flatMap(({ found }) => found.prices);
  for (const { text, path } of texts(spec)) {
    const found = literals(text);
    for (const phone of found.phones) {
      if (!phones.some((known) => samePhone(known, phone, country)) && !statedNumbers.has(digits(phone)))
        issues.push(
          error(path, 'unsupported_literal', `Remove the phone number "${phone}" or use the contact facts.`),
        );
    }
    for (const email of found.emails) {
      // A spelled-out address (`name (at) domain`) is compared as written with `@`.
      if (!emails.includes(mailbox(unspell(email))))
        issues.push(
          error(path, 'unsupported_literal', `Remove the e-mail address "${email}": it is not a fact.`),
        );
    }
    for (const price of found.prices) {
      const known = prices.some((p) => p.amount === price.amount && p.currency === price.currency);
      const stated = statedPrices.some((p) => p.amount === price.amount && p.currency === price.currency);
      if (!known && !stated)
        issues.push(
          error(
            path,
            'unsupported_literal',
            `Remove the price "${price.text}": only published prices (facts) may appear.`,
          ),
        );
    }
    for (const year of found.years) {
      if (!years.includes(year) && !statedYears.has(year))
        issues.push(error(path, 'unsupported_literal', `Remove the year ${year}: it is not a fact.`));
    }
  }
  return issues;
}
