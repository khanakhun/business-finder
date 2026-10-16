import { SITE_LOCALES, type SiteLocale } from '@bf/site-schema';

/** The visitor's preferred site language from Accept-Language (by quality), else English. */
export function preferredLocale(header: string | null | undefined): SiteLocale {
  const ranked = (header ?? '')
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().toLowerCase().split(';');
      const q = Number(
        params
          .find((param) => param.trim().startsWith('q='))
          ?.trim()
          .slice(2) ?? '1',
      );
      return { language: tag.split('-')[0] ?? '', q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((entry) => entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  return (ranked.find((entry) => SITE_LOCALES.includes(entry.language as SiteLocale))?.language ??
    'en') as SiteLocale;
}
