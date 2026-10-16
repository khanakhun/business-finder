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

/**
 * All features in registry order; fails fast (at import) when a definition has no compute function (a programming
 * error, hence a plain Error).
 */
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
 * The business's feature vector for a profile's offer, as stored with its score: a value the facts do not give is
 * `null` (missingness is information for BF-059; `withDefaults` applies the registry's defaults when scoring). A
 * value of the wrong type is a programming error, never a silent score: it throws.
 */
export function computeFeatures(facts: BusinessFacts, context: FeatureContext): FeatureVector {
  const vector: FeatureVector = {};
  for (const { key, definition, compute } of FEATURES) {
    const raw = compute(facts, context);
    if (!valid(definition, raw)) throw new TypeError(`Scoring feature ${key} computed an invalid value`);
    vector[key] = raw;
  }
  return vector;
}

/**
 * The vector scoring reads: a non-finite number (from a replayed or hand-written vector) counts as missing, and each
 * missing value is replaced by its feature's `missingDefault` when it has one.
 */
export function withDefaults(vector: FeatureVector): FeatureVector {
  const effective: FeatureVector = {};
  for (const { key, definition } of FEATURES) {
    const value = vector[key] ?? null;
    const known = typeof value === 'number' && !Number.isFinite(value) ? null : value;
    if (known !== null) effective[key] = known;
    else if (definition.missingDefault !== undefined) effective[key] = definition.missingDefault;
  }
  return effective;
}
