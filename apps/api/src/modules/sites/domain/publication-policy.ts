import type { SiteEnvironment, SiteStatus } from '@bf/contracts';

// Site and publication rules (BF-035, DOMAIN.md §3.4): a site's status follows its active publications; previews
// expire (30 days by default) and can be extended, never beyond 90 days ahead; an archived site publishes nothing.

export const PREVIEW_MAX_DAYS = 90;
const DAY = 86_400_000;

/** A site's status from its active publications (an archived site stays archived). */
export function siteStatus(current: SiteStatus, active: readonly SiteEnvironment[]): SiteStatus {
  if (current === 'archived') return 'archived';
  if (active.includes('live')) return 'live';
  if (active.includes('preview')) return 'preview';
  return 'draft';
}

/** The preview hostname of a site. */
export const previewHostname = (slug: string, baseDomain: string) => `${slug}.${baseDomain.toLowerCase()}`;

/** When a preview published now for `days` ends. */
export const previewExpiry = (now: Date, days: number) => new Date(now.getTime() + days * DAY);

/**
 * A preview's expiry after extending it by `days`: counted from its current expiry (or now, if that has passed),
 * capped at 90 days from now.
 */
export function extendedExpiry(now: Date, current: Date | null, days: number): Date {
  const from = current && current > now ? current : now;
  const wanted = from.getTime() + days * DAY;
  return new Date(Math.min(wanted, now.getTime() + PREVIEW_MAX_DAYS * DAY));
}
