/** The signed outreach reference of an e-mail's link (`?r=`): passed on to the opt-out as is, if it looks like one. */
const OUTREACH_REF = /^[A-Za-z0-9._-]{8,512}$/;

/**
 * The two entry points of a preview (BF-036): "this is my business" (the claim form, BF-048) and "not interested"
 * (opt-out, BF-055; a link from an e-mail carries its signed reference, so the opt-out can be one click). A button
 * exists only once its URL is configured.
 */
export function previewActionLinks(input: {
  readonly siteId: string;
  readonly claimUrl: string | undefined;
  readonly optOutUrl: string | undefined;
  readonly outreachRef: string | undefined;
}): { claim?: string; optOut?: string } {
  const link = (base: string, params: Record<string, string | undefined>) => {
    const url = new URL(base);
    for (const [name, value] of Object.entries(params)) if (value) url.searchParams.set(name, value);
    return url.href;
  };
  const ref = input.outreachRef && OUTREACH_REF.test(input.outreachRef) ? input.outreachRef : undefined;
  return {
    ...(input.claimUrl ? { claim: link(input.claimUrl, { site: input.siteId }) } : {}),
    ...(input.optOutUrl ? { optOut: link(input.optOutUrl, { site: input.siteId, r: ref }) } : {}),
  };
}
