import {
  DO_NOT_CONTACT_GATE_ID,
  FEATURE_KEYS,
  type FeatureVector,
  type Gate,
  type ScoreContribution,
  type ScoreResult,
  type ScoringProfileConfig,
} from '@bf/contracts';
import type { BusinessFacts } from './facts.ts';
import { computeFeatures, withDefaults } from './features/registry.ts';
import { decidingGate } from './gates.ts';
import { selectReasons } from './reasons.ts';
import { applyTransform } from './transforms.ts';

// The scoring engine (BF-031, Interpreter over a profile config): pure and deterministic — the same vector and
// profile version always give the same score, contributions and reasons.
//
// score = clamp(Σ contribution, 0, 100), contribution = 100 × weight × transformed ÷ Σ positive weights. A missing
// feature takes its registry default, else the profile's `missing` value (which can raise a score: the built-ins use
// it for booking only, capped while a crawl could still tell), else contributes nothing while its weight still counts. Then gates: an exclusion
// gives tier X and 0, a cap lowers the score; `do_not_contact` always excludes, whatever the profile says. Tiers: A
// from `tiers.A`, B from `tiers.B`, else C.

/** The engine's own gate: a business the workspace must not contact is never a prospect. */
export const DO_NOT_CONTACT_GATE: Gate = {
  id: DO_NOT_CONTACT_GATE_ID,
  when: { feature: 'do_not_contact', eq: true },
  effect: { type: 'exclude' },
  reason: { en: 'Marked do-not-contact.', fr: 'Marquée à ne pas contacter.' },
};

const ORDER = new Map(FEATURE_KEYS.map((key, index) => [key, index]));
const round = (value: number) => Math.round(value * 10_000) / 10_000;

/**
 * Scores a feature vector of the current `FEATURE_SET_VERSION` (an older snapshot misses newer keys, which would
 * read as missing: recompute the features from the facts instead of re-scoring old snapshots).
 */
export function scoreVector(config: ScoringProfileConfig, stored: FeatureVector): ScoreResult {
  // Registry defaults stand in for missing values; a profile's `missing` value for what is still missing.
  const vector = withDefaults(stored);
  const weighted = FEATURE_KEYS.filter((key) => (config.weights[key] ?? 0) !== 0).sort(
    (a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0),
  );
  const positive = weighted.reduce((sum, key) => sum + Math.max(0, config.weights[key] ?? 0), 0);
  const contributions: ScoreContribution[] = weighted.map((feature) => {
    const weight = config.weights[feature] ?? 0;
    const rawValue = vector[feature] ?? null;
    const own = stored[feature] ?? null;
    const known = typeof own === 'number' ? Number.isFinite(own) : own !== null;
    const measured = applyTransform(config.transforms[feature], rawValue);
    const filled = measured === null ? (config.missing[feature] ?? null) : null;
    const transformed = measured ?? filled;
    return {
      feature,
      rawValue,
      transformed: transformed === null ? null : round(transformed),
      imputed: filled !== null ? 'profile' : !known && rawValue !== null ? 'default' : null,
      weight,
      contribution:
        transformed === null || positive === 0 ? 0 : round((100 * weight * transformed) / positive),
    };
  });
  const total = contributions.reduce((sum, { contribution }) => sum + contribution, 0);
  const computed = Math.round(Math.min(100, Math.max(0, total)));
  const gate = decidingGate([DO_NOT_CONTACT_GATE, ...config.gates], vector);
  // A cap that does not lower the score still explains it, marked as not applied.
  const applied = gate !== null && (gate.effect.type === 'exclude' || gate.effect.max < computed);
  const excluded = gate?.effect.type === 'exclude';
  const score = excluded ? 0 : applied && gate?.effect.type === 'cap' ? gate.effect.max : computed;
  return {
    score,
    tier: excluded ? 'X' : score >= config.tiers.A ? 'A' : score >= config.tiers.B ? 'B' : 'C',
    // Kept for the snapshot either way; an excluded business is explained by its gate alone.
    contributions,
    reasons: excluded ? [] : selectReasons(config, contributions),
    gated: gate ? { gate: gate.id, effect: gate.effect.type, applied, reason: gate.reason } : null,
  };
}

/** Features for the profile's offer, then the score: what a business scores now. */
export function scoreBusiness(
  config: ScoringProfileConfig,
  facts: BusinessFacts,
): ScoreResult & { readonly features: FeatureVector } {
  const features = computeFeatures(facts, { offer: config.offer });
  return { ...scoreVector(config, features), features };
}
