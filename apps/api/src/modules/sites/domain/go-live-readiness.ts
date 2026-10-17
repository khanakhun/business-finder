import type { GoLiveCheck, SiteLegalProfile } from '@bf/contracts';

// Go-live readiness (BF-062, Specification): each rule says pass, warn or fail with the place that fixes it.
// Failures block the live publication; warnings do not. The deal rule (pipeline at proposal or won) may be
// overridden with a reason. French jurisdictions (the mainland and overseas: Saint-Barthélemy, Saint-Martin…)
// require the *mentions légales* identity of the publisher, its director and the host.

/** Where the LCEN's mentions légales apply. */
export const FRENCH_JURISDICTIONS = new Set([
  'FR',
  'BL',
  'MF',
  'GP',
  'MQ',
  'GF',
  'RE',
  'YT',
  'PM',
  'NC',
  'PF',
  'WF',
]);

export interface ReadinessInput {
  readonly siteId: string;
  readonly pipelineStatus: string | null;
  readonly overrideReason: string | null;
  readonly countryCode: string | null;
  /** Issues of the version validated for a live site (codes). */
  readonly liveErrors: readonly { code: string; message: string }[];
  readonly legal: SiteLegalProfile | null;
  /** The agency as host (workspace settings). */
  readonly host: { readonly name: string | null; readonly address: string | null };
  readonly routingVerified: boolean;
  /** The generation job behind the version: its quality outcome, or null (edited by hand). */
  readonly quality: 'succeeded' | 'needs_review' | 'failed' | null;
  readonly seo: { readonly missingSite: number; readonly missingPages: number };
}

const DEAL_STAGES = new Set(['proposal', 'won']);

export function evaluateReadiness(input: ReadinessInput): GoLiveCheck[] {
  const site = `/sites/${input.siteId}`;
  const checks: GoLiveCheck[] = [];
  const deal = input.pipelineStatus !== null && DEAL_STAGES.has(input.pipelineStatus);
  checks.push({
    id: 'deal',
    status: deal ? 'pass' : input.overrideReason ? 'warn' : 'fail',
    message: deal
      ? 'The business is at proposal or won.'
      : input.overrideReason
        ? `No deal yet: going live anyway (${input.overrideReason}).`
        : 'The business is not at proposal or won: move it, or give a reason to go live anyway.',
    fix: null,
  });
  const assetIssues = input.liveErrors.filter((issue) => issue.code === 'asset_preview_only');
  checks.push({
    id: 'assets',
    status: assetIssues.length ? 'fail' : 'pass',
    message: assetIssues.length
      ? `${assetIssues.length} image(s) from the business's website need their ownership confirmed or a replacement.`
      : 'Every image may be used on a live site.',
    fix: assetIssues.length ? `${site}?tab=assets` : null,
  });
  const french = FRENCH_JURISDICTIONS.has(input.countryCode ?? '');
  const legal = input.legal;
  const missing: string[] = [];
  if (!legal) missing.push('legal profile');
  else if (french) {
    if (!legal.legalForm) missing.push('legal form');
    if (!legal.registration) missing.push('registration (SIRET/RCS)');
    if (!legal.publicationDirector) missing.push('publication director');
    if (!legal.phone) missing.push('phone');
  }
  if (french && (!input.host.name || !input.host.address)) missing.push('host identity (workspace settings)');
  checks.push({
    id: 'legal',
    status: missing.length ? 'fail' : 'pass',
    message: missing.length
      ? `The legal notice needs: ${missing.join(', ')}.`
      : 'The legal notice has everything it needs.',
    fix: missing.length ? `${site}/go-live?step=legal` : null,
  });
  checks.push({
    id: 'privacy',
    status: legal?.privacyAcknowledgedAt ? 'pass' : 'fail',
    message: legal?.privacyAcknowledgedAt
      ? 'The privacy notice was reviewed.'
      : 'Review and accept the generated privacy notice.',
    fix: legal?.privacyAcknowledgedAt ? null : `${site}/go-live?step=legal`,
  });
  checks.push({
    id: 'routing',
    status: input.routingVerified ? 'pass' : 'fail',
    message: input.routingVerified
      ? 'Contact form messages go to a confirmed address.'
      : 'Confirm the address contact form messages are delivered to.',
    fix: input.routingVerified ? null : `${site}/go-live?step=routing`,
  });
  const other = input.liveErrors.filter((issue) => issue.code !== 'asset_preview_only');
  checks.push({
    id: 'content',
    status: other.length ? 'fail' : 'pass',
    message: other.length
      ? `${other.length} content error(s): ${other[0]?.message ?? ''}`
      : 'No content errors.',
    fix: other.length ? `${site}/edit` : null,
  });
  checks.push({
    id: 'quality',
    status: input.quality === 'failed' ? 'fail' : input.quality === 'needs_review' ? 'warn' : 'pass',
    message:
      input.quality === 'needs_review'
        ? 'The quality gates asked for a review: make sure it was done.'
        : input.quality === 'failed'
          ? 'The generation behind this version failed its quality gates.'
          : 'Quality gates passed (or the version was edited by hand).',
    fix: input.quality && input.quality !== 'succeeded' ? `${site}?tab=quality` : null,
  });
  checks.push({
    id: 'confirmation',
    status: legal?.contentConfirmedAt ? 'pass' : 'fail',
    message: legal?.contentConfirmedAt
      ? `Content reviewed by ${legal.contentConfirmedBy ?? 'the client'}.`
      : 'The client must confirm they reviewed the content (name and date).',
    fix: legal?.contentConfirmedAt ? null : `${site}/go-live?step=legal`,
  });
  const seoGaps = input.seo.missingSite + input.seo.missingPages;
  checks.push({
    id: 'seo',
    status: seoGaps ? 'warn' : 'pass',
    message: seoGaps
      ? `${seoGaps} search title(s) or description(s) are missing in a site language.`
      : 'Search titles and descriptions are set in every language.',
    fix: seoGaps ? `${site}/edit` : null,
  });
  return checks;
}
