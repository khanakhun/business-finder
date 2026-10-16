import {
  narrowerUsage,
  REVIEW_SOURCE_LICENSING,
  type ReviewGateBlocker,
  type ReviewSource,
  type ReviewSourceGate,
  type ReviewsUsage,
} from '@bf/contracts';

// Licensing gate (BF-029, Policy, pure): what a workspace may do with a source's reviews now. The workspace's choice
// never exceeds the source's licence, and a blocked source gives `none` — the step then stores nothing from it.

export interface GateFacts {
  /** The workspace's stored choice; undefined → the source's default. */
  readonly chosen: ReviewsUsage | undefined;
  /** Google: an owner acknowledged the current terms warning. */
  readonly acknowledged: boolean;
  /** Google: a Places API key is in the workspace vault. */
  readonly keyConfigured: boolean;
  /** Scraper: deployed, flag on and its own warning acknowledged. */
  readonly scraperAllowed: boolean;
}

export function resolveGate(source: ReviewSource, facts: GateFacts): ReviewSourceGate {
  const licensing = REVIEW_SOURCE_LICENSING[source];
  // Google is chosen by acknowledging its warning: the acknowledgement is the choice.
  const chosen =
    source === 'google_places'
      ? facts.acknowledged
        ? licensing.maxUsage
        : 'none'
      : (facts.chosen ?? licensing.defaultUsage);
  const usage = narrowerUsage(chosen, licensing.maxUsage);
  const blockedBy = blocker(source, usage, facts);
  return {
    source,
    maxUsage: licensing.maxUsage,
    usage,
    effective: blockedBy ? 'none' : usage,
    blockedBy,
    retentionDays: licensing.retentionDays,
  };
}

function blocker(source: ReviewSource, usage: ReviewsUsage, facts: GateFacts): ReviewGateBlocker | null {
  if (source === 'google_places') {
    if (!facts.acknowledged) return 'acknowledgement';
    if (!facts.keyConfigured) return 'not_configured';
  }
  if (usage === 'none') return 'not_enabled';
  if (source === 'gmaps_scraper' && !facts.scraperAllowed) return 'scraper_gates';
  return null;
}
