import type { SiteLocale, SiteSpec } from '@bf/site-schema';

/** The signed outreach reference of an e-mail's link (`?r=`): passed on to the opt-out as is, if it looks like one. */
const OUTREACH_REF = /^[A-Za-z0-9._-]{8,512}$/;

/**
 * The two entry points of a preview (BF-036), pages of the renderer itself in the page's language: "this is my
 * business" (`/claim`, BF-048) and "not interested" (`/opt-out`, BF-048/BF-055; a link from an e-mail carries its
 * signed reference, which the opt-out page verifies before asking to confirm: nothing happens on a GET).
 */
// DECISION(BF-036): off until BF-048 adds the two pages (SITES_PREVIEW_ACTIONS), so no preview links to a 404.
export function previewActionLinks(input: {
  readonly spec: SiteSpec;
  readonly locale: SiteLocale;
  readonly outreachRef: string | undefined;
}): { claim: string; optOut: string } {
  const prefix = input.locale === input.spec.defaultLocale ? '' : `/${input.locale}`;
  const ref = input.outreachRef && OUTREACH_REF.test(input.outreachRef) ? input.outreachRef : undefined;
  return {
    claim: `${prefix}/claim`,
    optOut: `${prefix}/opt-out${ref ? `?${new URLSearchParams({ r: ref })}` : ''}`,
  };
}
