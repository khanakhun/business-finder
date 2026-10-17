import type { SiteLocale, SiteSpec } from '@bf/site-schema';

// A live site's own pages (BF-062): the legal notice (/legal) and the privacy notice (/privacy), in each of the
// site's languages (`/legal`, `/en/legal`…), like the preview's lead pages. Pure (the proxy uses it too).

export const LIVE_PAGES = ['legal', 'privacy'] as const;
export type LivePage = (typeof LIVE_PAGES)[number];

export function livePageOf(
  spec: SiteSpec,
  segments: readonly string[],
): { page: LivePage; locale: SiteLocale } | null {
  const [first, second, ...rest] = segments;
  if (rest.length > 0 || !first) return null;
  const isPage = (value: string): value is LivePage => (LIVE_PAGES as readonly string[]).includes(value);
  if (second === undefined) return isPage(first) ? { page: first, locale: spec.defaultLocale } : null;
  if (!spec.locales.includes(first as SiteLocale) || first === spec.defaultLocale) return null;
  return isPage(second) ? { page: second, locale: first as SiteLocale } : null;
}
