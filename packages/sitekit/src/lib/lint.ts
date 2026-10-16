import { readFileSync } from 'node:fs';
import { type Fact, type FactRegistry, SITE_LOCALES, type SiteSpec } from '@bf/site-schema';
import { parse } from 'yaml';
import { z } from 'zod';
import type { SitekitConfig } from './config.ts';
import { pathString } from './validate.ts';

// Copy lint (BF-042): what the validator cannot see — clichés, unproven superlatives, invented numbers, placeholders,
// text in the wrong language, French typography, long sentences, duplicates, weak CTA labels, SEO lengths and empty
// alt texts. Rules are data (`rules/<locale>.yaml`); typography and whitespace have safe autofixes.

export const LINT_RULES = [
  'copy.placeholder',
  'copy.cliche',
  'copy.superlative',
  'copy.unsupported_number',
  'copy.wrong_language',
  'copy.fr_typography',
  'copy.whitespace',
  'copy.sentence_length',
  'copy.duplicate',
  'copy.cta_verb',
  'copy.seo_length',
  'copy.alt_text',
] as const;
export type LintRule = (typeof LINT_RULES)[number];

const DEFAULT_SEVERITY: Record<LintRule, 'error' | 'warning'> = {
  'copy.placeholder': 'error',
  'copy.cliche': 'warning',
  'copy.superlative': 'error',
  'copy.unsupported_number': 'error',
  'copy.wrong_language': 'warning',
  'copy.fr_typography': 'warning',
  'copy.whitespace': 'warning',
  'copy.sentence_length': 'warning',
  'copy.duplicate': 'warning',
  'copy.cta_verb': 'warning',
  'copy.seo_length': 'warning',
  'copy.alt_text': 'warning',
};

export interface LintIssue {
  readonly rule: LintRule;
  readonly severity: 'error' | 'warning';
  readonly path: readonly (string | number)[];
  readonly at: string;
  readonly locale: string;
  readonly message: string;
  readonly hint: string;
  /** The corrected text, when the fix is safe to apply automatically. */
  readonly fix?: string;
}

const CommonRulesSchema = z.object({
  placeholders: z.array(z.string()),
  alt: z.object({ banned_prefixes: z.array(z.string()), filename: z.string() }),
  sentence: z.object({ max_words: z.number().int().positive() }),
  seo: z.object({ title: z.tuple([z.number(), z.number()]), description: z.tuple([z.number(), z.number()]) }),
  duplicates: z.object({ min_words: z.number().int().positive() }),
});
const LocaleRulesSchema = z.object({
  cliches: z.array(z.string()),
  superlatives: z.array(z.string()),
  cta_verbs: z.array(z.string()),
  stopwords: z.array(z.string()),
});
type LocaleRules = z.infer<typeof LocaleRulesSchema>;

const RULES_DIR = new URL('../../rules/', import.meta.url);
const readRules = (name: string) => parse(readFileSync(new URL(name, RULES_DIR), 'utf8'));

let cached: { common: z.infer<typeof CommonRulesSchema>; locales: Map<string, LocaleRules> } | undefined;
export function rules() {
  if (!cached) {
    const locales = new Map<string, LocaleRules>();
    for (const locale of ['fr', 'en'])
      locales.set(locale, LocaleRulesSchema.parse(readRules(`${locale}.yaml`)));
    cached = { common: CommonRulesSchema.parse(readRules('common.yaml')), locales };
  }
  return cached;
}

interface TextField {
  readonly path: readonly (string | number)[];
  readonly locale: string;
  readonly text: string;
  readonly kind: 'text' | 'cta_label' | 'seo_title' | 'seo_description' | 'alt';
}

const LOCALES = new Set<string>(SITE_LOCALES);
const isLocalized = (value: unknown): value is Record<string, string> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length > 0 &&
  Object.entries(value).every(([key, text]) => LOCALES.has(key) && typeof text === 'string');

/** Every localized text of the site the visitor reads (not the theme, contact or settings). */
export function textFields(spec: SiteSpec): TextField[] {
  const fields: TextField[] = [];
  const walk = (value: unknown, path: (string | number)[], parent: unknown) => {
    if (isLocalized(value)) {
      const key = path.at(-1);
      const inSeo = path.includes('seo');
      const kind: TextField['kind'] =
        path[0] === 'assets' && key === 'alt'
          ? 'alt'
          : inSeo && key === 'title'
            ? 'seo_title'
            : inSeo && key === 'description'
              ? 'seo_description'
              : key === 'label' && parent && typeof parent === 'object' && 'kind' in parent
                ? 'cta_label'
                : 'text';
      for (const [locale, text] of Object.entries(value))
        fields.push({ path: [...path, locale], locale, text, kind });
      return;
    }
    if (Array.isArray(value))
      value.forEach((item, index) => {
        walk(item, [...path, index], value);
      });
    else if (value && typeof value === 'object')
      for (const [key, child] of Object.entries(value)) walk(child, [...path, key], value);
  };
  for (const key of ['layout', 'navigation', 'pages', 'assets', 'seo'] as const) walk(spec[key], [key], spec);
  return fields;
}

const words = (text: string) => text.split(/\s+/).filter((word) => /\p{L}/u.test(word));
const sentences = (text: string) =>
  text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
const normalize = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const NBSP = ' ';
const NNBSP = ' ';

/** French typography: a (narrow) no-break space before `; ! ? :` and inside « », curly apostrophes. */
export function frenchTypography(text: string): string {
  return text
    .replace(/(\p{L}|\d)'(?=\p{L})/gu, '$1’')
    .replace(/([^\s  (])([;!?])/gu, (match, before: string, mark: string, offset: number, all: string) =>
      // Not inside a URL or an emoticon-like run ("?!" keeps one space before the first mark).
      /https?:\/\/\S*$/.test(all.slice(0, offset + 1)) || /[;!?]/.test(before)
        ? match
        : `${before}${NNBSP}${mark}`,
    )
    .replace(/ ([;!?])/g, `${NNBSP}$1`)
    .replace(/([^\s  \d])(:)(?=\s|$)/gu, `$1${NBSP}$2`)
    .replace(/ :(?=\s|$)/g, `${NBSP}:`)
    .replace(/«\s*/g, `«${NBSP}`)
    .replace(/\s*»/g, `${NBSP}»`);
}

export const tidyWhitespace = (text: string) =>
  text.replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+|[ \t]+$/gm, '');

function guessLanguage(
  text: string,
  rulesByLocale: Map<string, LocaleRules>,
): { locale: string; share: number } | null {
  const tokens = normalize(text).split(' ');
  if (tokens.length < 6) return null;
  let best: { locale: string; share: number } | null = null;
  for (const [locale, localeRules] of rulesByLocale) {
    const stop = new Set(localeRules.stopwords.map(normalize));
    const share = tokens.filter((token) => stop.has(token)).length / tokens.length;
    if (!best || share > best.share) best = { locale, share };
  }
  return best;
}

/** Digits of every fact value (a number in the copy must be one of them). */
function factNumbers(facts: readonly Fact[]): Set<string> {
  const numbers = new Set<string>();
  for (const fact of facts)
    for (const match of JSON.stringify(fact.value).matchAll(/\d+(?:[.,]\d+)?/g)) {
      numbers.add(match[0].replace(',', '.'));
      numbers.add(match[0].replace(/[.,]\d+$/, ''));
    }
  return numbers;
}

export interface LintInput {
  readonly facts?: FactRegistry;
  /** Lint only this locale. */
  readonly locale?: string;
  readonly config: SitekitConfig;
}

export function lintCopy(spec: SiteSpec, input: LintInput): LintIssue[] {
  const { common, locales } = rules();
  const severityOf = (rule: LintRule) => input.config.lint[rule] ?? DEFAULT_SEVERITY[rule];
  const facts = input.facts?.facts ?? [];
  const hasAward = facts.some((fact) => fact.kind === 'award');
  const known = factNumbers(facts);
  const issues: LintIssue[] = [];
  const push = (field: TextField, rule: LintRule, message: string, hint: string, fix?: string) => {
    const severity = severityOf(rule);
    if (severity === 'off') return;
    issues.push({
      rule,
      severity,
      path: field.path,
      at: pathString(field.path),
      locale: field.locale,
      message,
      hint,
      ...(fix !== undefined ? { fix } : {}),
    });
  };
  const seen = new Map<string, string>();
  const placeholders = common.placeholders.map((pattern) => new RegExp(pattern, 'i'));
  const altFilename = new RegExp(common.alt.filename, 'i');

  for (const field of textFields(spec)) {
    if (input.locale && field.locale !== input.locale) continue;
    const text = field.text;
    const localeRules = locales.get(field.locale);
    const placeholder = placeholders.find((pattern) => pattern.test(text));
    if (placeholder)
      push(
        field,
        'copy.placeholder',
        `Placeholder text: "${text.match(placeholder)?.[0]}".`,
        'Write the real text, from facts only, or remove the field.',
      );
    const tidy = tidyWhitespace(text);
    if (tidy !== text)
      push(field, 'copy.whitespace', 'Extra spaces.', 'Remove doubled, leading and trailing spaces.', tidy);

    if (field.kind === 'alt') {
      const lower = text.trim().toLowerCase();
      if (
        !lower ||
        common.alt.banned_prefixes.some((prefix) => lower.startsWith(prefix)) ||
        altFilename.test(lower)
      )
        push(
          field,
          'copy.alt_text',
          `Alt text "${text}" says nothing about the picture.`,
          'Describe what the image shows in a short phrase ("The terrace at sunset"), not "image of" or a file name.',
        );
      continue;
    }
    if (field.kind === 'seo_title' || field.kind === 'seo_description') {
      const [min, max] = field.kind === 'seo_title' ? common.seo.title : common.seo.description;
      if (text.length < min || text.length > max)
        push(
          field,
          'copy.seo_length',
          `${field.kind === 'seo_title' ? 'SEO title' : 'SEO description'} is ${text.length} characters (aim for ${min}–${max}).`,
          `Rewrite it to ${min}–${max} characters.`,
        );
    }
    if (field.kind === 'cta_label' && localeRules) {
      const first = normalize(text).split(' ')[0] ?? '';
      const verbs = new Set(localeRules.cta_verbs.map(normalize));
      if (!verbs.has(first))
        push(
          field,
          'copy.cta_verb',
          `CTA "${text}" does not start with an action.`,
          `Start with a verb (${localeRules.cta_verbs.slice(0, 4).join(', ')}…).`,
        );
    }
    if (localeRules) {
      const lower = text.toLowerCase();
      for (const cliche of localeRules.cliches)
        if (lower.includes(cliche.toLowerCase()))
          push(
            field,
            'copy.cliche',
            `Cliché: "${cliche}".`,
            'Say something specific to the business instead (a fact from facts.json).',
          );
      if (!hasAward)
        for (const pattern of localeRules.superlatives) {
          const match = text.match(new RegExp(pattern, 'iu'));
          if (match)
            push(
              field,
              'copy.superlative',
              `Unproven superlative: "${match[0]}".`,
              'Remove it: superlatives need an award fact (none in facts.json).',
            );
        }
      if (field.locale === 'fr') {
        const fixed = frenchTypography(text);
        if (fixed !== text)
          push(
            field,
            'copy.fr_typography',
            'French typography: spaces before ; ! ? : and inside « », curly apostrophes.',
            'Apply the French punctuation spacing (sitekit lint-copy --fix does it).',
            fixed,
          );
      }
      const guess = guessLanguage(text, locales);
      if (guess && guess.locale !== field.locale && guess.share >= 0.2) {
        const own = guessLanguage(text, new Map([[field.locale, localeRules]]));
        if (!own || own.share < guess.share / 2)
          push(
            field,
            'copy.wrong_language',
            `This ${field.locale} text reads as ${guess.locale}.`,
            `Write it in ${field.locale}.`,
          );
      }
    }
    for (const match of text.matchAll(/\d+(?:[.,]\d+)?/g)) {
      const number = match[0].replace(',', '.');
      if (!known.has(number) && !known.has(number.replace(/\.\d+$/, '')))
        push(
          field,
          'copy.unsupported_number',
          `The number ${match[0]} is not in any fact.`,
          'Remove the number, or use one stated in facts.json.',
        );
    }
    for (const sentence of sentences(text)) {
      const count = words(sentence).length;
      if (count > common.sentence.max_words)
        push(
          field,
          'copy.sentence_length',
          `A sentence of ${count} words.`,
          `Split it: keep sentences under ${common.sentence.max_words} words.`,
        );
      if (count >= common.duplicates.min_words) {
        const key = `${field.locale}\u0000${normalize(sentence)}`;
        const first = seen.get(key);
        if (first && first !== pathString(field.path.slice(0, -1)))
          push(field, 'copy.duplicate', `The same sentence is at ${first}.`, 'Say it once, or vary it.');
        else seen.set(key, pathString(field.path.slice(0, -1)));
      }
    }
  }
  return issues;
}

/** The spec with every safe fix applied (typography, whitespace); the other issues stay for the agent. */
export function applyLintFixes(
  spec: SiteSpec,
  issues: readonly LintIssue[],
): { spec: SiteSpec; fixed: number } {
  const next = structuredClone(spec);
  let fixed = 0;
  // Several fixes may touch one text: re-run them on the current value.
  const byPath = new Map<string, LintIssue[]>();
  for (const issue of issues)
    if (issue.fix !== undefined) byPath.set(issue.at, [...(byPath.get(issue.at) ?? []), issue]);
  for (const list of byPath.values()) {
    const path = list[0]?.path ?? [];
    let parent: unknown = next;
    for (const part of path.slice(0, -1)) parent = (parent as Record<string | number, unknown>)[part];
    const key = path.at(-1) as string;
    const holder = parent as Record<string, string>;
    let text = holder[key] ?? '';
    for (const issue of list) {
      const before = text;
      text = issue.rule === 'copy.fr_typography' ? frenchTypography(text) : tidyWhitespace(text);
      if (text !== before) fixed++;
    }
    holder[key] = text;
  }
  return { spec: next, fixed };
}
