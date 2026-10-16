import type { FeatureVector, Gate, GateCondition } from '@bf/contracts';

// Gates (BF-031, Specification): conditions on the feature vector that exclude a business (tier X) or cap its
// score. Exclusions win over caps; among caps the lowest wins; among equals, the first in the profile.

export function matches(condition: GateCondition, vector: FeatureVector): boolean {
  if ('all' in condition) return condition.all.every((part) => matches(part, vector));
  if ('any' in condition) return condition.any.some((part) => matches(part, vector));
  if ('not' in condition) return !matches(condition.not, vector);
  const value = vector[condition.feature] ?? null;
  if (condition.isNull !== undefined) return (value === null) === condition.isNull;
  if (value === null) return false;
  if (condition.eq !== undefined) return value === condition.eq;
  if (condition.neq !== undefined) return value !== condition.neq;
  if (condition.in !== undefined) return condition.in.includes(value);
  if (typeof value !== 'number') return false;
  if (condition.gt !== undefined) return value > condition.gt;
  if (condition.gte !== undefined) return value >= condition.gte;
  if (condition.lt !== undefined) return value < condition.lt;
  if (condition.lte !== undefined) return value <= condition.lte;
  return false;
}

/** The gate that decides, if any. */
export function decidingGate(gates: readonly Gate[], vector: FeatureVector): Gate | null {
  let decided: Gate | null = null;
  for (const gate of gates) {
    if (!matches(gate.when, vector)) continue;
    if (gate.effect.type === 'exclude') return gate;
    if (!decided || (decided.effect.type === 'cap' && gate.effect.max < decided.effect.max)) decided = gate;
  }
  return decided;
}
