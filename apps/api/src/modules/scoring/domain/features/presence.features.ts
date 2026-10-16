import type { BusinessFacts } from '../facts.ts';
import { type FeatureComputes, readableSite, round } from './feature.ts';

// Presence features (BF-031): the website and what its latest audit and crawl say.

const YEAR_MS = 365.25 * 86_400_000;

/** The most recent sign of an update: copyright year (its last day), dated content, sitemap, Last-Modified. */
function lastUpdate(facts: BusinessFacts): number | null {
  const freshness = readableSite(facts)?.freshness;
  if (!freshness) return null;
  const dates = [
    freshness.copyrightYear !== null ? Date.UTC(freshness.copyrightYear, 11, 31) : null,
    freshness.latestDatedContent ? Date.parse(freshness.latestDatedContent) : null,
    freshness.sitemapLastmod ? Date.parse(freshness.sitemapLastmod) : null,
    freshness.httpLastModified ? Date.parse(freshness.httpLastModified) : null,
  ].filter((date): date is number => date !== null && Number.isFinite(date));
  return dates.length > 0 ? Math.max(...dates) : null;
}

export const presenceFeatures: FeatureComputes = {
  has_website: (facts) => facts.business.websiteUrl !== null,
  website_status: (facts) => (facts.business.websiteUrl === null ? 'none' : (facts.audit?.status ?? null)),
  website_quality_score: (facts) => facts.audit?.qualityScore ?? null,
  psi_mobile_performance: (facts) => facts.audit?.psiMobilePerformance ?? null,
  lcp_mobile_seconds: (facts) => {
    const ms = facts.audit?.lcpMobileMs;
    return typeof ms === 'number' ? round(ms / 1000, 2) : null;
  },
  vision_overall: (facts) => facts.audit?.visionOverall ?? null,
  has_https: (facts) => readableSite(facts)?.security.https ?? null,
  site_freshness_years: (facts) => {
    const updated = lastUpdate(facts);
    return updated === null ? null : round(Math.max(0, (Date.parse(facts.asOf) - updated) / YEAR_MS), 1);
  },
  has_booking_tool: (facts) => {
    const site = readableSite(facts);
    return site
      ? site.booking.providers.length > 0 || site.pages.some((page) => page.kind === 'booking')
      : null;
  },
  has_online_menu: (facts) => {
    const site = readableSite(facts);
    return site
      ? site.ordering.providers.length > 0 || site.pages.some((page) => page.kind === 'menu')
      : null;
  },
  has_contact_form: (facts) => {
    const site = readableSite(facts);
    return site ? site.contacts.contactForms.length > 0 : null;
  },
  // The audit's language rules know the market (tourism, French-speaking countries).
  has_language_gap_for_market: (facts) =>
    facts.audit && readableSite(facts)
      ? facts.audit.findingCodes.some((code) => code === 'missing_english' || code === 'missing_french')
      : null,
  // Only a page that was actually read says anything (`checked`).
  no_solicitation_notice: (facts) => {
    const notice = facts.site?.noSolicitation;
    return notice?.checked ? notice.detected : null;
  },
};
