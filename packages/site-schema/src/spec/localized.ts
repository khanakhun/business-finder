import { z } from 'zod';

/** Languages a generated site can be published in (the dashboard's own languages are separate). */
export const SITE_LOCALES = ['fr', 'en', 'nl', 'es', 'de'] as const;
export const SiteLocaleSchema = z.enum(SITE_LOCALES).describe('A site language (ISO 639-1).');
export type SiteLocale = z.infer<typeof SiteLocaleSchema>;

/** No control or invisible formatting characters (direction overrides, zero-width spaces); line breaks allowed. */
const SAFE_TEXT = /^(?:[^\p{Cc}\p{Cf}]|\n)*$/u;
const SAFE_LINE = /^[^\p{Cc}\p{Cf}]*$/u;

/** Text shown on the site (one language): trimmed, bounded, no hidden characters. */
export const safeText = (max: number) =>
  z.string().trim().min(1).max(max).regex(SAFE_TEXT, 'No control or invisible characters');

/** A single-line text that is not localized (a name, an author), bounded, no hidden characters. */
export const plainText = (max: number, description: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(SAFE_LINE, 'No control or invisible characters')
    .describe(description);

/**
 * Text in the site's languages: `{ "fr": "…", "en": "…" }`. Every site locale must be present (the semantic validator
 * reports a missing one at its path); the schema bounds each text's length.
 */
export function localized(max: number, description: string) {
  return z
    .partialRecord(SiteLocaleSchema, safeText(max))
    .refine((text) => Object.keys(text).length > 0, { message: 'At least one locale' })
    .describe(`${description} One entry per site locale, at most ${max} characters each.`)
    .meta({ minProperties: 1 });
}
export type LocalizedText = Partial<Record<SiteLocale, string>>;

/** Stable ids of pages (readable, used in links and navigation). */
export const PageIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,31}$/)
  .describe(
    'A page id: lowercase letters, digits and dashes, starting with a letter (e.g. "home", "services").',
  );

/** Ids of blocks and assets (nanoid-like, unique within the site). */
export const ElementIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{6,32}$/)
  .describe('A unique id of 6–32 URL-safe characters (e.g. "hero-1a2b", "img_cafe_terrace").');

/** A fact of the business's fact registry (BF-040): every factual value names the fact it states. */
export const FactIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_.:-]{1,79}$/)
  .describe(
    'The id of the fact this value comes from in the fact registry (e.g. "phone.main", "price.cut_women").',
  );

/** An https URL (the validator checks the host against the allowlist that applies). */
export const HttpsUrlSchema = z
  .string()
  .max(500)
  .regex(/^https:\/\/[^\s/$.?#\\][^\s\\]*$/i)
  .describe('An absolute https URL.');
