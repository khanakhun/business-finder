import type { EngineCapabilities, EngineId } from '@bf/contracts';

// "Auto" engine selection (BF-039): an explainable choice among the engines the workspace allows and that are
// available now. Small sites go to the deterministic blocks engine; larger or multilingual ones to an agent engine
// with the shortest estimated wait that fits the budget.

export interface EngineCandidate {
  readonly id: EngineId;
  readonly available: boolean;
  readonly capabilities: EngineCapabilities;
  /** Jobs waiting on its queue. */
  readonly backlog: number;
  /** Runs in progress. */
  readonly running: number;
}

export interface SelectionInput {
  readonly allowed: readonly EngineId[];
  readonly candidates: readonly EngineCandidate[];
  /** Pages the brief plans, items (services, menu) and languages: how much there is to write. */
  readonly complexity: { readonly pages: number; readonly items: number; readonly locales: number };
  readonly budgetUsd: number;
}

export type Selection =
  | { readonly engine: EngineId; readonly reason: string }
  | { readonly engine: null; readonly reason: string };

/** Minutes until an engine could start this job (its backlog over its parallelism, at its typical duration). */
export function estimatedWaitSec(candidate: EngineCandidate): number {
  const slots = Math.max(1, candidate.capabilities.maxParallel);
  const ahead = candidate.backlog + Math.max(0, candidate.running - slots + 1);
  return Math.ceil(ahead / slots) * candidate.capabilities.typicalDurationSec;
}

export function selectEngine(input: SelectionInput): Selection {
  const usable = input.candidates.filter(
    (candidate) => input.allowed.includes(candidate.id) && candidate.available,
  );
  if (usable.length === 0) return { engine: null, reason: 'no allowed engine is available' };
  const affordable = usable.filter((candidate) => candidate.capabilities.typicalCostUsd <= input.budgetUsd);
  if (affordable.length === 0)
    return { engine: null, reason: `no engine fits the budget of $${input.budgetUsd}` };
  const simple = input.complexity.pages <= 4 && input.complexity.items <= 12 && input.complexity.locales <= 2;
  const blocks = affordable.find((candidate) => candidate.id === 'blocks');
  if (simple && blocks)
    return {
      engine: 'blocks',
      reason: 'simple site (≤ 4 pages, ≤ 12 items, ≤ 2 languages): the blocks engine',
    };
  const agents = affordable.filter((candidate) => candidate.id !== 'blocks');
  const pool = agents.length > 0 ? agents : affordable;
  const [best] = [...pool].sort(
    (a, b) =>
      estimatedWaitSec(a) - estimatedWaitSec(b) ||
      a.capabilities.typicalCostUsd - b.capabilities.typicalCostUsd ||
      a.id.localeCompare(b.id),
  );
  if (!best) return { engine: null, reason: 'no engine' };
  const wait = estimatedWaitSec(best);
  return {
    engine: best.id,
    reason: `${simple ? 'simple site, blocks unavailable' : 'larger site'}: ${best.id} (shortest wait ≈ ${Math.round(wait / 60)} min, ~$${best.capabilities.typicalCostUsd})`,
  };
}
