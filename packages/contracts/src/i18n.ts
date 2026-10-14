import { z } from 'zod';

/** Supported content/UI locales; add a code here to support a new language. */
export const LOCALES = ['fr', 'en'] as const;
export const LocaleSchema = z.enum(LOCALES);
export type Locale = z.infer<typeof LocaleSchema>;

/** Text in one or more locales, e.g. `{ fr: 'Boulangerie', en: 'Bakery' }`. At least one non-empty value. */
export const LocalizedTextSchema = z
  .partialRecord(LocaleSchema, z.string())
  .refine((text) => Object.values(text).some((value) => value !== undefined && value.trim() !== ''), {
    message: 'At least one locale must have text',
  });
export type LocalizedText = z.infer<typeof LocalizedTextSchema>;

/** First non-empty text among `preferred` locales, then `fallback`, then any locale; undefined if none. */
export function pickLocale(
  text: LocalizedText,
  preferred: readonly Locale[],
  fallback: Locale = 'en',
): string | undefined {
  for (const locale of [...preferred, fallback, ...LOCALES]) {
    const value = text[locale];
    if (value !== undefined && value.trim() !== '') return value;
  }
  return undefined;
}
