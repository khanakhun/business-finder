import {
  FEATURE_DEFINITIONS,
  FEATURE_KEYS,
  type FeatureDefinition,
  type FeatureKey,
  type FeatureValue,
  type FeatureVector,
} from '@bf/contracts';
import type { BusinessFacts } from '../facts.ts';
import { businessFeatures } from './business.features.ts';
import type { FeatureCompute, FeatureContext } from './feature.ts';
import { painFeatures } from './pain.features.ts';
import { presenceFeatures } from './presence.features.ts';
import { reachabilityFeatures } from './reachability.features.ts';
import { workspaceFeatures } from './workspace.features.ts';

// The feature registry (BF-031, Registry): every key of `FEATURE_DEFINITIONS` has exactly one compute function, and
// every value is checked against its definition (type, enum values, finite numbers) before it enters a vector.

const COMPUTES: Partial<Record<FeatureKey, FeatureCompute>> = {
  ...presenceFeatures,
  ...businessFeatures,
  ...painFeatures,
  ...reachabilityFeatures,
  ...workspaceFeatures,
};

export interface Feature {
  readonly key: FeatureKey;
  readonly definition: FeatureDefinition;
  readonly compute: FeatureCompute;
}

/** All features in registry order; fails fast (at import) when a definition has no compute function. */
export const FEATURES: readonly Feature[] = FEATURE_KEYS.map((key) => {
  const compute = COMPUTES[key];
  if (!compute) throw new Error(`Scoring feature ${key} has no compute function`);
  return { key, definition: FEATURE_DEFINITIONS[key], compute };
});

const valid = (definition: FeatureDefinition, value: FeatureValue): boolean => {
  if (value === null) return true;
  switch (definition.type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'enum':
      return typeof value === 'string' && (definition.values ?? []).includes(value);
  }
};

/**
 * The business's feature vector for a profile's offer. A value the facts do not give is the definition's
 * `missingDefault`, else null; a value of the wrong type is a bug and throws.
 */
export function computeFeatures(facts: BusinessFacts, context: FeatureContext): FeatureVector {
  const vector: FeatureVector = {};
  for (const { key, definition, compute } of FEATURES) {
    const raw = compute(facts, context);
    if (!valid(definition, raw)) throw new TypeError(`Scoring feature ${key} computed an invalid value`);
    vector[key] = raw ?? definition.missingDefault ?? null;
  }
  return vector;
}
