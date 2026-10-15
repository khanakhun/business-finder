import type { MappingOrigin } from '@bf/contracts';

// Classification chain decisions (BF-015, Chain of Responsibility): mapping → synonyms → LLM. Each step proposes
// a primary category with a confidence; the first at or above the threshold wins, otherwise the best proposal is
// returned for human review.

export type ClassificationOrigin = 'mapping' | 'synonym' | 'llm';

export interface StepProposal {
  readonly origin: ClassificationOrigin;
  /** Category slug. */
  readonly primary: string;
  readonly secondary: readonly string[];
  readonly confidence: number;
}

export interface ClassificationResult {
  readonly primary: string | null;
  readonly secondary: readonly string[];
  readonly confidence: number;
  readonly origin: ClassificationOrigin | 'none';
  readonly needsReview: boolean;
}

export const DEFAULT_ACCEPT_THRESHOLD = 0.75;

export const UNCLASSIFIED: ClassificationResult = {
  primary: null,
  secondary: [],
  confidence: 0,
  origin: 'none',
  needsReview: true,
};

/** Whether a proposal is good enough to stop the chain. */
export const accepts = (proposal: StepProposal | null, threshold = DEFAULT_ACCEPT_THRESHOLD): boolean =>
  proposal !== null && proposal.confidence >= threshold;

/** Final decision from the proposals collected so far (in chain order). */
export function decide(
  proposals: ReadonlyArray<StepProposal | null>,
  threshold = DEFAULT_ACCEPT_THRESHOLD,
): ClassificationResult {
  const present = proposals.filter((p): p is StepProposal => p !== null);
  const winner = present.find((p) => accepts(p, threshold));
  const chosen = winner ?? [...present].sort((a, b) => b.confidence - a.confidence)[0];
  if (!chosen) return UNCLASSIFIED;
  // Other steps' picks are useful secondaries (a bar that is also a restaurant).
  const secondary = [...new Set([...chosen.secondary, ...present.map((p) => p.primary)])]
    .filter((slug) => slug !== chosen.primary)
    .slice(0, 3);
  return {
    primary: chosen.primary,
    secondary,
    confidence: chosen.confidence,
    origin: chosen.origin,
    needsReview: winner === undefined,
  };
}

export interface MappingCandidate {
  readonly slug: string;
  readonly origin: MappingOrigin;
  readonly confidence: number;
}

const ORIGIN_RANK: Record<MappingOrigin, number> = { human: 3, seed: 2, llm: 1 };

/** Mapping precedence: human > seed > llm, then confidence. */
export function rankMappings(mappings: readonly MappingCandidate[]): MappingCandidate[] {
  return [...mappings].sort(
    (a, b) =>
      ORIGIN_RANK[b.origin] - ORIGIN_RANK[a.origin] ||
      b.confidence - a.confidence ||
      a.slug.localeCompare(b.slug),
  );
}

/** The mapping step's proposal from the active mappings of a business's provider categories. */
export function proposeFromMappings(mappings: readonly MappingCandidate[]): StepProposal | null {
  const [best, ...rest] = rankMappings(mappings);
  if (!best) return null;
  return {
    origin: 'mapping',
    primary: best.slug,
    secondary: [...new Set(rest.map((m) => m.slug))].filter((s) => s !== best.slug).slice(0, 3),
    confidence: best.confidence,
  };
}
