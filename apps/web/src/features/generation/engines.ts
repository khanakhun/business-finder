import type { EngineRequest, GenerationEngineListing } from '@bf/contracts';

// Engine choices of the create flow (BF-046): the engines a person may pick, an "assign by pattern" helper
// ("2 Claude Code + 2 Codex + rest Blocks", by position) and the batch estimate. Pure: the sheet renders them.

/** The engines people pick, in the order they are offered. */
export const PICKABLE_ENGINES = ['auto', 'blocks', 'claude-agent-sdk', 'claude-code', 'codex'] as const;
export type PickableEngine = EngineRequest;

/** The choices: the usual ones, plus the fake engine where it is registered (test deployments only). */
export function pickableEngines(listing: GenerationEngineListing | undefined): PickableEngine[] {
  const fake = listing?.items.some((item) => item.id === 'fake') ?? false;
  return [...PICKABLE_ENGINES, ...(fake ? (['fake'] as const) : [])];
}

/** Why an engine cannot be picked: not on this deployment, or not usable by this workspace (key, settings). */
export function unavailableReason(
  engine: PickableEngine,
  listing: GenerationEngineListing | undefined,
): 'off' | 'unavailable' | null {
  if (engine === 'auto' || !listing) return null;
  const item = listing.items.find((candidate) => candidate.id === engine);
  if (!item) return 'off';
  return item.available ? null : 'unavailable';
}

const ALIASES: Record<string, PickableEngine> = {
  auto: 'auto',
  blocks: 'blocks',
  block: 'blocks',
  'claude-agent-sdk': 'claude-agent-sdk',
  'agent-sdk': 'claude-agent-sdk',
  sdk: 'claude-agent-sdk',
  'claude-code': 'claude-code',
  claude: 'claude-code',
  codex: 'codex',
  fake: 'fake',
};

export interface PatternPart {
  /** How many items (null: every item left). */
  readonly count: number | null;
  readonly engine: PickableEngine;
}

/**
 * Reads a pattern like "2 claude-code + 2 codex + rest blocks" (also "2 × Claude Code, 2 Codex, rest Blocks"):
 * parts separated by `+` or `,`; each a count (or "rest") and an engine. Returns null when a part does not read.
 */
export function parsePattern(text: string): PatternPart[] | null {
  const parts = text
    .split(/[+,]/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const parsed: PatternPart[] = [];
  for (const part of parts) {
    const match = /^(\d+|le reste|reste|rest)\b\s*(?:[x×*]\s*)?(.+)$/.exec(part);
    if (!match) return null;
    const engine = ALIASES[(match[2] as string).trim().replace(/\s+/g, '-')];
    if (!engine) return null;
    parsed.push({ count: /^\d+$/.test(match[1] as string) ? Number(match[1]) : null, engine });
  }
  return parsed;
}

/** The engine of each of `count` items, by position, from a pattern (items past the counts keep `fallback`). */
export function assignEngines(
  count: number,
  pattern: readonly PatternPart[],
  fallback: PickableEngine = 'auto',
): PickableEngine[] {
  const out: PickableEngine[] = [];
  const rest = pattern.find((part) => part.count === null)?.engine;
  for (const part of pattern) {
    if (part.count === null) continue;
    for (let i = 0; i < part.count && out.length < count; i++) out.push(part.engine);
  }
  while (out.length < count) out.push(rest ?? fallback);
  return out;
}

export interface Estimate {
  readonly costUsd: number;
  /** Seconds until the last item should be done (typical durations, the run mode, no queue). */
  readonly etaSec: number;
}

/** The typical cost and duration of the batch: "auto" counts as the cheapest available engine. */
export function estimate(
  engines: readonly EngineRequest[],
  listing: GenerationEngineListing | undefined,
  maxParallel: number,
): Estimate {
  const items = listing?.items ?? [];
  const available = items.filter((item) => item.available);
  const cheapest = [...available].sort(
    (a, b) => a.capabilities.typicalCostUsd - b.capabilities.typicalCostUsd,
  )[0];
  const of = (engine: EngineRequest) =>
    engine === 'auto' ? cheapest : (items.find((item) => item.id === engine) ?? cheapest);
  const durations = engines.map((engine) => of(engine)?.capabilities.typicalDurationSec ?? 0);
  const costUsd = engines.reduce((sum, engine) => sum + (of(engine)?.capabilities.typicalCostUsd ?? 0), 0);
  // Greedy lanes: each item goes to the lane that frees up first.
  const lanes = new Array<number>(Math.max(1, maxParallel)).fill(0);
  for (const duration of durations) {
    const lane = lanes.indexOf(Math.min(...lanes));
    lanes[lane] = (lanes[lane] ?? 0) + duration;
  }
  return { costUsd: Math.round(costUsd * 100) / 100, etaSec: Math.max(0, ...lanes) };
}

/** Parallel runs by default: the selected engines' slots (their max in parallel), at most the item count. */
export function defaultParallel(
  engines: readonly EngineRequest[],
  listing: GenerationEngineListing | undefined,
): number {
  const slots =
    new Set(engines).size === 0
      ? 1
      : [...new Set(engines)].reduce((sum, engine) => {
          const item = listing?.items.find((candidate) => candidate.id === engine);
          return sum + (item?.capabilities.maxParallel ?? 2);
        }, 0);
  return Math.max(1, Math.min(20, slots, engines.length));
}
