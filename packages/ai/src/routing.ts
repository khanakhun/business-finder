import type { AiTask, AiTier } from './define-task.ts';

export type AiProvider = 'anthropic' | 'openai';

export interface ModelRef {
  readonly provider: AiProvider;
  readonly model: string;
}

/** Model choice is configuration (ADR-0011): tiers, per-task overrides, fallbacks, embeddings. */
export interface RoutingConfig {
  readonly tiers: Readonly<Record<AiTier, string>>;
  /** Task name → model reference. */
  readonly overrides?: Readonly<Record<string, string>>;
  /** Model reference (or tier name) → models to try when it is unavailable, in order. */
  readonly fallbacks?: Readonly<Record<string, readonly string[]>>;
  readonly embeddingModel: string;
}

export const DEFAULT_TIERS: Readonly<Record<AiTier, string>> = {
  fast: 'claude-haiku-5-5',
  smart: 'claude-sonnet-5-5',
  agent: 'claude-opus-5-5',
};
export const DEFAULT_EMBEDDING_MODEL = 'openai:text-embedding-3-small';

/** `provider:model`, or a bare id whose prefix names the provider (`claude-*` → Anthropic, `gpt-*`/`o<N>*`/`text-embedding-*` → OpenAI). */
export function parseModelRef(ref: string): ModelRef {
  const explicit = /^(anthropic|openai):(.+)$/.exec(ref);
  if (explicit) return { provider: explicit[1] as AiProvider, model: explicit[2] as string };
  if (ref.startsWith('claude-')) return { provider: 'anthropic', model: ref };
  if (/^(gpt-|o\d|text-embedding-|chatgpt-)/.test(ref)) return { provider: 'openai', model: ref };
  throw new Error(
    `Cannot tell the provider of model "${ref}"; write it as "anthropic:<id>" or "openai:<id>"`,
  );
}

/** The models to try for a task, primary first, then its fallbacks (deduplicated). */
export function routeFor(task: Pick<AiTask, 'name' | 'tier'>, config: RoutingConfig): ModelRef[] {
  const primary = config.overrides?.[task.name] ?? config.tiers[task.tier];
  const fallbacks = config.fallbacks?.[primary] ?? config.fallbacks?.[task.tier] ?? [];
  const seen = new Set<string>();
  return [primary, ...fallbacks].map(parseModelRef).filter((ref) => {
    const id = `${ref.provider}:${ref.model}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
