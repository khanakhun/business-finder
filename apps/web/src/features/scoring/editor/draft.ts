import {
  FEATURE_DEFINITIONS,
  FEATURE_KEYS,
  type FeatureKey,
  type Gate,
  type ScoringProfileConfig,
  ScoringProfileConfigSchema,
  TRANSFORM_KINDS_FOR,
  type Transform,
} from '@bf/contracts';
import { fromGate, type GateDraft, toGate } from './gates.ts';

// The profile editor's draft (BF-032): a config whose gates are edited as builder drafts. `build` gives the config
// the server scores and saves, or the problems that keep it from being one (at their config paths). Editing a draft
// never touches stored scores: only saving a version and activating it does.

export interface Draft {
  readonly config: ScoringProfileConfig;
  readonly gates: readonly GateDraft[];
}

export interface Issue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export function toDraft(config: ScoringProfileConfig): Draft {
  return { config, gates: config.gates.map((gate) => fromGate(gate)) };
}

export function build(draft: Draft): { config: ScoringProfileConfig | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const gates: Gate[] = [];
  draft.gates.forEach((gateDraft, i) => {
    const gate = toGate(gateDraft);
    if (gate) gates.push(gate);
    else issues.push({ path: ['gates', i, 'when'], message: 'incompleteGate' });
  });
  const parsed = ScoringProfileConfigSchema.safeParse({ ...draft.config, gates });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        path: issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part)),
        message: issue.message,
      });
    }
  }
  return { config: issues.length === 0 && parsed.success ? parsed.data : null, issues };
}

/** Each weight's share of the positive weights (the score's scale: 100 × Σ weight × value ÷ Σ positive weights). */
export function normalizedWeights(weights: ScoringProfileConfig['weights']): Map<FeatureKey, number> {
  const positive = Object.values(weights).reduce((sum, w) => sum + Math.max(0, w ?? 0), 0);
  const shares = new Map<FeatureKey, number>();
  for (const [key, weight] of Object.entries(weights) as [FeatureKey, number][]) {
    shares.set(key, positive > 0 ? weight / positive : 0);
  }
  return shares;
}

/** A transform to start from: the feature's usual range, its values, or yes = 1. */
export function defaultTransform(feature: FeatureKey): Transform | undefined {
  const { type, range, values } = FEATURE_DEFINITIONS[feature];
  if (type === 'boolean') return { kind: 'boolean', true: 1, false: 0 };
  if (type === 'enum')
    return { kind: 'enumMap', map: Object.fromEntries((values ?? []).map((v) => [v, 0])), default: 0 };
  // Already on 0–1: no transform needed.
  if (range && range[0] === 0 && range[1] === 1) return undefined;
  return { kind: 'linear', min: range?.[0] ?? 0, max: range?.[1] ?? 100 };
}

export function transformKinds(feature: FeatureKey): readonly Transform['kind'][] {
  return TRANSFORM_KINDS_FOR[FEATURE_DEFINITIONS[feature].type];
}

/** A transform of another kind, seeded from the feature. */
export function transformOfKind(feature: FeatureKey, kind: Transform['kind']): Transform {
  const { range, values } = FEATURE_DEFINITIONS[feature];
  const [min, max] = range ?? [0, 100];
  switch (kind) {
    case 'linear':
    case 'inverse':
      return { kind, min, max };
    case 'log':
      return { kind, max: max > 0 ? max : 100 };
    case 'piecewise':
      return {
        kind,
        points: [
          [min, 0],
          [max, 1],
        ],
      };
    case 'boolean':
      return { kind, true: 1, false: 0 };
    case 'enumMap':
      return { kind, map: Object.fromEntries((values ?? []).map((v) => [v, 0])), default: 0 };
  }
}

/** Adds a feature with a weight (and its starting transform), or changes its weight. */
export function withWeight(
  config: ScoringProfileConfig,
  feature: FeatureKey,
  weight: number,
): ScoringProfileConfig {
  const transforms = { ...config.transforms };
  if (config.weights[feature] === undefined && transforms[feature] === undefined) {
    const transform = defaultTransform(feature);
    if (transform) transforms[feature] = transform;
  }
  return { ...config, weights: { ...config.weights, [feature]: weight }, transforms };
}

/** Removes a feature from the profile (its weight, transform, missing value and reason texts). */
export function withoutFeature(config: ScoringProfileConfig, feature: FeatureKey): ScoringProfileConfig {
  const drop = <T extends object>(record: T): T => {
    const copy = { ...record } as Record<string, unknown>;
    delete copy[feature];
    return copy as T;
  };
  return {
    ...config,
    weights: drop(config.weights),
    transforms: drop(config.transforms),
    missing: drop(config.missing),
    reasonTemplates: drop(config.reasonTemplates),
  };
}

/** Features not weighted yet (the "add a feature" list), in registry order. */
export function unweighted(config: ScoringProfileConfig): FeatureKey[] {
  return FEATURE_KEYS.filter((key) => config.weights[key] === undefined);
}

/** Reason template keys a feature reads (most specific first): its values, below/above its pivot, any value. */
export function reasonKeys(feature: FeatureKey, config: ScoringProfileConfig): string[] {
  const { type, values, pivot } = FEATURE_DEFINITIONS[feature];
  return [
    ...(type === 'boolean' ? ['true', 'false'] : []),
    ...(type === 'enum' ? [...(values ?? [])] : []),
    ...(pivot !== undefined ? ['below', 'above'] : []),
    'value',
    ...(config.missing[feature] !== undefined ? ['missing'] : []),
  ];
}
