/** Dashboard locales (no URL prefix: the choice lives in a cookie). EN is the default. */
export const LOCALES = ['en', 'fr'] as const;
export type AppLocale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: AppLocale = 'en';
export const LOCALE_COOKIE = 'bf_locale';

export function isLocale(value: string | undefined): value is AppLocale {
  return value !== undefined && (LOCALES as readonly string[]).includes(value);
}

/** Best locale for an Accept-Language header (first supported language wins). */
export function negotiateLocale(acceptLanguage: string | null): AppLocale {
  for (const part of (acceptLanguage ?? '').split(',')) {
    const language = part.trim().split(';')[0]?.split('-')[0]?.toLowerCase();
    if (isLocale(language)) return language;
  }
  return DEFAULT_LOCALE;
}
