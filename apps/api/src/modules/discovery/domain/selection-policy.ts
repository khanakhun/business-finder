import type { DiscoveryTile, ProviderCapabilities, ProviderId } from '@bf/contracts';

// Provider selection (BF-018, Strategy): which providers serve an intent, in the workspace's preference order.

export const EXCLUSION_REASONS = [
  'unavailable',
  'disabled',
  'not_configured',
  'unsupported',
  'over_budget',
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export interface ProviderCandidate {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  /** Feature flags and deployment switches allow it. */
  readonly available: boolean;
  /** Not disabled in the workspace's discovery settings. */
  readonly enabled: boolean;
  /** Its secret resolves (or it needs none). */
  readonly configured: boolean;
  /** Estimated cost of serving the intent (0 for open data). */
  readonly estimatedCostUsd: number;
}

export interface SelectionInput {
  readonly needs: {
    readonly keywords: boolean;
    readonly categories: boolean;
    readonly tile: DiscoveryTile['type'];
  };
  readonly preferenceOrder: readonly ProviderId[];
  readonly candidates: readonly ProviderCandidate[];
  /** What is left of the workspace's monthly provider budget (null: no cap). */
  readonly budgetRemainingUsd: number | null;
}

export interface SelectionResult {
  readonly selected: readonly ProviderId[];
  readonly excluded: ReadonlyArray<{ readonly id: ProviderId; readonly reason: ExclusionReason }>;
}

function fits(capabilities: ProviderCapabilities, needs: SelectionInput['needs']): boolean {
  if (needs.keywords && !needs.categories && !capabilities.textQuery) return false;
  if (needs.categories && !capabilities.categoryFilter && !capabilities.textQuery) return false;
  return needs.tile === 'Circle'
    ? capabilities.circle || capabilities.bbox
    : capabilities.bbox || capabilities.polygon;
}

/**
 * Keeps providers that are available, enabled, configured, able to serve the intent and affordable, in preference
 * order (unranked providers last, by id). Paid providers are admitted while their cumulative estimate fits the
 * remaining budget; free ones always fit.
 */
export function selectProviders(input: SelectionInput): SelectionResult {
  const rank = (id: ProviderId) => {
    const index = input.preferenceOrder.indexOf(id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const ordered = [...input.candidates].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  const selected: ProviderId[] = [];
  const excluded: Array<{ id: ProviderId; reason: ExclusionReason }> = [];
  let budget = input.budgetRemainingUsd;
  for (const candidate of ordered) {
    const reason: ExclusionReason | null = !candidate.available
      ? 'unavailable'
      : !candidate.enabled
        ? 'disabled'
        : !candidate.configured
          ? 'not_configured'
          : !fits(candidate.capabilities, input.needs)
            ? 'unsupported'
            : budget !== null && candidate.estimatedCostUsd > budget
              ? 'over_budget'
              : null;
    if (reason) {
      excluded.push({ id: candidate.id, reason });
      continue;
    }
    selected.push(candidate.id);
    if (budget !== null) budget -= candidate.estimatedCostUsd;
  }
  return { selected, excluded };
}
