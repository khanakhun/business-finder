import type { OutreachReadiness, PostalAddress } from '@bf/contracts';

/** What outreach needs from the workspace before sending (outreach-compliance.md §2: sender identity, address). */
export function outreachReadiness(settings: {
  readonly agencyName: string | null;
  readonly postalAddress: PostalAddress | null;
}): OutreachReadiness {
  const missing: OutreachReadiness['missing'] = [];
  if (!settings.agencyName?.trim()) missing.push('agency_name');
  if (!settings.postalAddress) missing.push('postal_address');
  return { ready: missing.length === 0, missing };
}
