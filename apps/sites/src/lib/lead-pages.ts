import { signLeadFormToken } from '@bf/contracts';
import type { SiteLocale, SiteSpec } from '@bf/site-schema';

// The renderer's own pages on a preview (BF-048): "this is my business" (/claim), "don't contact me" (/opt-out) and
// the agency's privacy notice (/privacy), in each of the site's languages (`/claim`, `/en/claim`…).

export const LEAD_PAGES = ['claim', 'opt-out', 'privacy'] as const;
export type LeadPage = (typeof LEAD_PAGES)[number];

/** The version of the privacy notice a consent refers to (bump it when the text changes). */
export const PRIVACY_VERSION = 'privacy-2026-10';

/** The lead page a path names, and its language (null when it is not one). */
export function leadPageOf(
  spec: SiteSpec,
  segments: readonly string[],
): { page: LeadPage; locale: SiteLocale } | null {
  const [first, second, ...rest] = segments;
  if (rest.length > 0 || !first) return null;
  if (second === undefined)
    return (LEAD_PAGES as readonly string[]).includes(first)
      ? { page: first as LeadPage, locale: spec.defaultLocale }
      : null;
  if (!spec.locales.includes(first as SiteLocale) || first === spec.defaultLocale) return null;
  return (LEAD_PAGES as readonly string[]).includes(second)
    ? { page: second as LeadPage, locale: first as SiteLocale }
    : null;
}

/** The hidden fields a lead form posts: tokens, kind, source, its id, language, the way back, attribution. */
export async function leadFormFields(input: {
  readonly siteToken: string;
  readonly siteId: string;
  readonly secret: string;
  readonly kind: 'claim_interest' | 'contact_request' | 'opt_out';
  readonly source: 'banner' | 'claim_page' | 'contact_block' | 'opt_out_link' | 'live_site';
  readonly locale: string;
  readonly next: string;
  readonly campaign?: string | undefined;
  readonly outreachRef?: string | undefined;
}): Promise<Record<string, string>> {
  return {
    siteToken: input.siteToken,
    formToken: await signLeadFormToken(input.siteId, Date.now(), input.secret),
    kind: input.kind,
    source: input.source,
    submissionId: crypto.randomUUID(),
    locale: input.locale,
    consentVersion: PRIVACY_VERSION,
    next: input.next,
    ...(input.campaign && /^[A-Za-z0-9_-]{1,64}$/.test(input.campaign) ? { c: input.campaign } : {}),
    ...(input.outreachRef && /^[A-Za-z0-9._-]{8,512}$/.test(input.outreachRef)
      ? { r: input.outreachRef }
      : {}),
  };
}
