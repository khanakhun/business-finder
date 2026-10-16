import { defaultPageHref } from '@bf/site-blocks';
import type { Page, SiteLocale, SiteSpec } from '@bf/site-schema';

export interface Route {
  readonly page: Page;
  readonly locale: SiteLocale;
}

/**
 * The page and language a path is for: the default language at the root (`/`, `/carte`), the others under their
 * prefix (`/en`, `/en/carte`). Undefined for anything else (an unknown slug, a nested path, the default language's
 * own prefix): a 404.
 */
export function resolveRoute(spec: SiteSpec, segments: readonly string[]): Route | undefined {
  const [first, ...others] = segments;
  const prefixed =
    first !== undefined && first !== spec.defaultLocale && spec.locales.includes(first as SiteLocale);
  const locale = prefixed ? (first as SiteLocale) : spec.defaultLocale;
  const rest = prefixed ? others : segments;
  if (rest.length > 1) return undefined;
  const slug = rest[0] ?? '';
  const page = spec.pages.find((candidate) => candidate.slug === slug);
  return page ? { page, locale } : undefined;
}

/** A page's path in each of the site's languages (the language switcher and `hreflang` keep the same page). */
export function pageAlternates(spec: SiteSpec, page: Page): Record<string, string> {
  return Object.fromEntries(spec.locales.map((locale) => [locale, defaultPageHref(page, locale, spec)]));
}

/** The language a path is in (its prefix, else the site's default), found page or not: its 404 speaks it. */
export function localeOfPath(spec: SiteSpec, segments: readonly string[]): SiteLocale {
  const [first] = segments;
  return first !== undefined && spec.locales.includes(first as SiteLocale)
    ? (first as SiteLocale)
    : spec.defaultLocale;
}
