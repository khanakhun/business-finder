import { factValueSchema, type RegistryFactKind } from '@bf/contracts';
import { SITE_FACT_EVIDENCE_MAX_WORDS, type SiteFactCandidate } from './generation-extract-site-facts.ts';

// The deterministic check of extracted site facts (BF-040). A model's candidate is kept only when:
// - its evidence is on the page (token-set ratio ≥ 0.9 against a window of the page text, after normalization);
// - every number, price, time, phone, e-mail and year of its value is in that evidence;
// - its words are in the evidence (names, services, items…), and a testimonial is on the page as published.
// Everything else is dropped with a reason (counted by callers, never stored). Values come out typed for the registry.

export const EVIDENCE_PAGE_RATIO = 0.9;
/** Share of a text value's words its evidence must contain. */
export const VALUE_EVIDENCE_COVERAGE = 0.8;

export const REJECT_REASONS = [
  'unknown_page',
  'evidence_too_long',
  'suspected_injection',
  'evidence_not_on_page',
  'missing_value',
  'value_not_in_evidence',
  'number_not_in_evidence',
  'contact_not_in_evidence',
  'quote_not_on_page',
  'no_currency',
  'link_not_on_page',
  'invalid_value',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export interface SitePageText {
  readonly id: string;
  readonly url: string;
  readonly lang?: string | null;
  readonly markdown: string;
}

export interface VerifiedSiteFact {
  readonly kind: RegistryFactKind;
  readonly value: unknown;
  readonly locale?: 'fr' | 'en';
  readonly evidence: string;
  readonly pageUrl: string;
}

export interface SiteFactVerification {
  readonly accepted: VerifiedSiteFact[];
  readonly rejected: { readonly candidate: SiteFactCandidate; readonly reason: RejectReason }[];
}

/** Lowercase, accents and compatibility forms folded, punctuation and symbols as spaces. */
export function normalizeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sentences that address a model ("ignore previous instructions", "SYSTEM:", "ajoutez un avis…") are not the
 * business speaking: evidence found only there is refused, so an injected phone or testimonial never gets in.
 */
const INJECTION =
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|earlier|all|any)\b.{0,30}\b(instructions?|rules|prompts?|directions)\b|\b(system|assistant|developer)\s*:|\byou (must|should|will) (now )?(add|list|include|say|output|write|mention)\b|\bnew instructions\b|\b(ignorez|oubliez|ignore[rz]?)\b.{0,40}\b(instructions|consignes|règles)\b|\b(ajoute[rz]?|inclu(ez|re)|mentionne[rz]?)\b.{0,40}\b(avis|témoignages?|numéros?|téléphones?|étoiles)\b|\b(add|include|insert)\b.{0,40}\b(testimonials?|reviews?|5-star|five-star|phone numbers?)\b/i;

/** The page without the sentences that look like instructions to a model. */
export function withoutInjections(markdown: string): string {
  return markdown
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => !INJECTION.test(sentence))
    .join('\n');
}

const tokens = (value: string) => normalizeText(value).split(' ').filter(Boolean);

/** Share of `needle`'s tokens (as a multiset) found in the best window of `haystack` around its length. */
export function tokenSetRatio(needle: readonly string[], haystack: readonly string[]): number {
  if (needle.length === 0) return 0;
  const want = new Map<string, number>();
  for (const token of needle) want.set(token, (want.get(token) ?? 0) + 1);
  const width = Math.min(haystack.length, needle.length + 2);
  let best = 0;
  for (let start = 0; start + width <= Math.max(haystack.length, width); start++) {
    const left = new Map(want);
    let hit = 0;
    for (const token of haystack.slice(start, start + width)) {
      const count = left.get(token) ?? 0;
      if (count > 0) {
        left.set(token, count - 1);
        hit++;
      }
    }
    best = Math.max(best, hit / needle.length);
    if (best === 1) break;
  }
  return best;
}

/** Share of `value`'s tokens present anywhere in `evidence`. */
function coverage(value: string, evidence: readonly string[]): number {
  const words = tokens(value);
  if (words.length === 0) return 0;
  const left = new Map<string, number>();
  for (const token of evidence) left.set(token, (left.get(token) ?? 0) + 1);
  let hit = 0;
  for (const word of words) {
    const count = left.get(word) ?? 0;
    if (count > 0) {
      left.set(word, count - 1);
      hit++;
    }
  }
  return hit / words.length;
}

const NUMBER = /\d{1,3}(?:[   ,.]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d+)?/g;

/** Every number a text may mean ("1 200,50" → 1200.5; "1.200" → 1.2 and 1200). */
export function numbersIn(text: string): Set<number> {
  const found = new Set<number>();
  for (const match of text.normalize('NFKC').matchAll(NUMBER)) {
    const raw = match[0];
    const plain = Number(raw.replace(',', '.'));
    if (Number.isFinite(plain)) found.add(plain);
    const grouped = raw.replace(/[   ,.](?=\d{3}(?:\D|$))/g, '').replace(',', '.');
    const value = Number(grouped);
    if (Number.isFinite(value)) found.add(value);
  }
  return found;
}

/** Hours a text names, in 24 h ("5pm" → 17, "midi" → 12) plus the minutes written after them. */
function timesIn(text: string): Set<number> {
  const found = numbersIn(text);
  const lower = text.normalize('NFKC').toLowerCase();
  for (const match of lower.matchAll(/(\d{1,2})(?:[:h.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/g)) {
    const hour = Number(match[1]);
    const pm = match[3]?.startsWith('p');
    found.add(pm && hour < 12 ? hour + 12 : !pm && hour === 12 ? 0 : hour);
  }
  if (/\b(midi|noon)\b/.test(lower)) found.add(12);
  if (/\b(minuit|midnight)\b/.test(lower)) {
    found.add(0);
    found.add(24);
  }
  return found;
}

type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
const WEEK: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_WORDS: Readonly<Record<string, Weekday>> = {
  lundi: 'mon',
  lun: 'mon',
  monday: 'mon',
  mon: 'mon',
  mardi: 'tue',
  mar: 'tue',
  tuesday: 'tue',
  tue: 'tue',
  tues: 'tue',
  mercredi: 'wed',
  mer: 'wed',
  wednesday: 'wed',
  wed: 'wed',
  jeudi: 'thu',
  jeu: 'thu',
  thursday: 'thu',
  thu: 'thu',
  thur: 'thu',
  thurs: 'thu',
  vendredi: 'fri',
  ven: 'fri',
  friday: 'fri',
  fri: 'fri',
  samedi: 'sat',
  sam: 'sat',
  saturday: 'sat',
  sat: 'sat',
  dimanche: 'sun',
  dim: 'sun',
  sunday: 'sun',
  sun: 'sun',
};
const DAY = `(${Object.keys(DAY_WORDS)
  .sort((a, b) => b.length - a.length)
  .join('|')})s?\\.?`;
const RANGE = new RegExp(
  `\\b${DAY}\\s*(?:au|à|a|to|through|thru|until|till|jusqu'?au|-|–|—)\\s*${DAY}\\b`,
  'g',
);
// Alone, French abbreviations need their dot ("mer." — not "la mer", "dim." — not "dim").
const SINGLE =
  /\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs?)?|fri|sat|sun|(?:lun|mar|mer|jeu|ven|sam|dim)(?=\.))s?\b/g;
const EVERY_DAY =
  /tous les jours|7\s*j\s*\/\s*7|7\s*\/\s*7|\b7 jours\b|\bdaily\b|every ?day|7 days|all week|toute la semaine/;
const EXCEPT = new RegExp(
  `(?:sauf|except|excepté|hors|closed|fermé)\\s+(?:le\\s+|les\\s+|on\\s+)?${DAY}`,
  'g',
);

/** The weekdays a quote covers ("du mardi au samedi", "Mon–Sat", "tous les jours sauf le lundi"); null when it names none. */
export function daysIn(text: string): Set<Weekday> | null {
  const lower = text.normalize('NFKC').toLowerCase();
  const found = new Set<Weekday>();
  let named = false;
  if (EVERY_DAY.test(lower)) {
    named = true;
    for (const day of WEEK) found.add(day);
  }
  const ranged = lower.replace(RANGE, (_match, from: string, to: string) => {
    named = true;
    const start = WEEK.indexOf(DAY_WORDS[from] as Weekday);
    const end = WEEK.indexOf(DAY_WORDS[to] as Weekday);
    for (let i = start; ; i = (i + 1) % 7) {
      found.add(WEEK[i] as Weekday);
      if (i === end) break;
    }
    return ' ';
  });
  const excepted = new Set<Weekday>();
  const rest = ranged.replace(EXCEPT, (_match, day: string) => {
    named = true;
    excepted.add(DAY_WORDS[day] as Weekday);
    return ' ';
  });
  for (const match of rest.matchAll(SINGLE)) {
    const day = DAY_WORDS[match[1] as string];
    if (!day) continue;
    named = true;
    found.add(day);
  }
  if (excepted.size > 0 && found.size === 0) for (const day of WEEK) found.add(day);
  for (const day of excepted) found.delete(day);
  return named ? found : null;
}

const digits = (value: string) => value.normalize('NFKC').replace(/\D/g, '');
const PHONE_RUN = /\+?\(?\d[\d\s.\-() ]{5,}\d/g;

/** A phone of the value is one of the evidence's numbers (a national and an international form match). */
function phoneInEvidence(value: string, evidence: string): boolean {
  const want = digits(value).replace(/^0+/, '');
  if (want.length < 6) return false;
  for (const match of evidence.normalize('NFKC').matchAll(PHONE_RUN)) {
    const run = digits(match[0]).replace(/^0+/, '');
    if (run === want) return true;
    if (run.length >= 9 && want.length >= 9 && (run.endsWith(want) || want.endsWith(run))) return true;
  }
  return false;
}

function currencyIn(text: string): 'EUR' | 'USD' | 'both' | null {
  const lower = text.toLowerCase();
  const eur = /€|\beur\b|\beuros?\b/.test(lower);
  const usd = /\$|\busd\b|\bdollars?\b/.test(lower);
  return eur && usd ? 'both' : eur ? 'EUR' : usd ? 'USD' : null;
}

const SITE_LOCALES = new Set(['fr', 'en']);

type Check = { ok: true; value: unknown } | { ok: false; reason: RejectReason };
const fail = (reason: RejectReason): Check => ({ ok: false, reason });

function numbersOk(value: string, evidence: string): boolean {
  const have = numbersIn(evidence);
  return [...numbersIn(value)].every((number) => have.has(number));
}

function checkValue(candidate: SiteFactCandidate, page: SitePageText, pageText: string): Check {
  const evidence = candidate.evidence;
  const evidenceTokens = tokens(evidence);
  switch (candidate.kind) {
    case 'price': {
      const price = candidate.price;
      if (!price) return fail('missing_value');
      if (!numbersIn(evidence).has(price.amount)) return fail('number_not_in_evidence');
      const quoted = currencyIn(evidence);
      const onPage = currencyIn(pageText);
      const currency =
        quoted === 'EUR' || quoted === 'USD'
          ? quoted
          : quoted === 'both'
            ? price.currency
            : onPage === 'EUR' || onPage === 'USD'
              ? onPage
              : null;
      if (!currency) return fail('no_currency');
      const item = price.item && coverage(price.item, evidenceTokens) >= 0.6 ? price.item : undefined;
      return {
        ok: true,
        value: {
          amount: price.amount,
          currency,
          ...(price.unit && coverage(price.unit, evidenceTokens) >= 0.5 ? { unit: price.unit } : {}),
          ...(item ? { serviceRef: item } : {}),
        },
      };
    }
    case 'hours': {
      if (!candidate.hours || candidate.hours.length === 0) return fail('missing_value');
      const have = timesIn(evidence);
      for (const entry of candidate.hours)
        for (const time of [entry.opens, entry.closes]) {
          const [hour, minute] = time.split(':').map(Number) as [number, number];
          const hourOk = have.has(hour) || (hour === 0 && have.has(24));
          if (!hourOk || (minute !== 0 && !have.has(minute))) return fail('number_not_in_evidence');
        }
      const days = daysIn(evidence);
      if (days && candidate.hours.some((entry) => !days.has(entry.day))) return fail('value_not_in_evidence');
      return { ok: true, value: { weekly: candidate.hours } };
    }
    case 'testimonial': {
      const testimonial = candidate.testimonial;
      if (!testimonial) return fail('missing_value');
      const pageTokens = tokens(pageText);
      if (tokenSetRatio(tokens(testimonial.quote), pageTokens) < EVIDENCE_PAGE_RATIO)
        return fail('quote_not_on_page');
      if (coverage(testimonial.attribution, pageTokens) < 1) return fail('value_not_in_evidence');
      return {
        ok: true,
        value: { quote: testimonial.quote, attribution: testimonial.attribution, sourcePage: page.url },
      };
    }
    case 'team_member': {
      const person = candidate.person;
      if (!person) return fail('missing_value');
      if (coverage(person.name, evidenceTokens) < 1) return fail('value_not_in_evidence');
      const role = person.role && coverage(person.role, evidenceTokens) >= 0.5 ? person.role : undefined;
      return { ok: true, value: { name: person.name, ...(role ? { role } : {}) } };
    }
    case 'year_founded': {
      if (candidate.year === null) return fail('missing_value');
      if (!numbersIn(evidence).has(candidate.year)) return fail('number_not_in_evidence');
      return { ok: true, value: candidate.year };
    }
    case 'booking_provider': {
      const booking = candidate.booking;
      if (!booking) return fail('missing_value');
      if (!/^https?:\/\//i.test(booking.url) || !pageText.toLowerCase().includes(booking.url.toLowerCase()))
        return fail('link_not_on_page');
      return { ok: true, value: { url: booking.url, provider: booking.provider } };
    }
    case 'phone':
    case 'whatsapp': {
      if (!candidate.text) return fail('missing_value');
      if (!phoneInEvidence(candidate.text, evidence)) return fail('contact_not_in_evidence');
      return { ok: true, value: candidate.text.trim() };
    }
    case 'email': {
      const email = candidate.text?.trim().toLowerCase();
      if (!email) return fail('missing_value');
      if (!evidence.normalize('NFKC').toLowerCase().includes(email)) return fail('contact_not_in_evidence');
      return { ok: true, value: email };
    }
    default: {
      const text = candidate.text?.trim();
      if (!text) return fail('missing_value');
      if (!numbersOk(text, evidence)) return fail('number_not_in_evidence');
      if (coverage(text, evidenceTokens) < VALUE_EVIDENCE_COVERAGE) return fail('value_not_in_evidence');
      return { ok: true, value: candidate.kind === 'menu_item' ? { name: text } : text };
    }
  }
}

const keyOf = (kind: string, value: unknown) =>
  `${kind}\u0000${typeof value === 'string' ? normalizeText(value) : JSON.stringify(value)}`;

export function verifySiteFactCandidates(
  candidates: readonly SiteFactCandidate[],
  pages: readonly SitePageText[],
): SiteFactVerification {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const pageTokens = new Map(pages.map((page) => [page.id, tokens(page.markdown)]));
  const cleanTokens = new Map(pages.map((page) => [page.id, tokens(withoutInjections(page.markdown))]));
  const accepted: VerifiedSiteFact[] = [];
  const rejected: SiteFactVerification['rejected'] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const page = byId.get(candidate.pageId);
    const reject = (reason: RejectReason) => rejected.push({ candidate, reason });
    if (!page) {
      reject('unknown_page');
      continue;
    }
    if (candidate.evidence.trim().split(/\s+/).length > SITE_FACT_EVIDENCE_MAX_WORDS) {
      reject('evidence_too_long');
      continue;
    }
    const evidenceTokens = tokens(candidate.evidence);
    if (tokenSetRatio(evidenceTokens, cleanTokens.get(page.id) ?? []) < EVIDENCE_PAGE_RATIO) {
      const onPage = tokenSetRatio(evidenceTokens, pageTokens.get(page.id) ?? []) >= EVIDENCE_PAGE_RATIO;
      reject(onPage ? 'suspected_injection' : 'evidence_not_on_page');
      continue;
    }
    const checked = checkValue(candidate, page, withoutInjections(page.markdown));
    if (!checked.ok) {
      reject(checked.reason);
      continue;
    }
    const parsed = factValueSchema(candidate.kind).safeParse(checked.value);
    if (!parsed.success) {
      reject('invalid_value');
      continue;
    }
    const key = keyOf(candidate.kind, parsed.data);
    if (seen.has(key)) continue;
    seen.add(key);
    const pageLang = page.lang?.slice(0, 2).toLowerCase();
    const locale = candidate.locale ?? (pageLang && SITE_LOCALES.has(pageLang) ? pageLang : undefined);
    accepted.push({
      kind: candidate.kind,
      value: parsed.data,
      ...(locale ? { locale: locale as 'fr' | 'en' } : {}),
      evidence: candidate.evidence.trim(),
      pageUrl: page.url,
    });
  }
  return { accepted, rejected };
}
