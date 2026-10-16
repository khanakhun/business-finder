import {
  FEATURE_KEYS,
  type FeatureVector,
  type Gate,
  type ScoreContribution,
  type ScoreResult,
  type ScoringProfileConfig,
} from '@bf/contracts';
import type { BusinessFacts } from './facts.ts';
import { computeFeatures } from './features/registry.ts';
import { decidingGate } from './gates.ts';
import { selectReasons } from './reasons.ts';
import { applyTransform } from './transforms.ts';

// The scoring engine (BF-031, Interpreter over a profile config): pure and deterministic — the same vector and
// profile version always give the same score, contributions and reasons.
//
// score = clamp(Σ contribution, 0, 100), contribution = 100 × weight × transformed ÷ Σ positive weights. A missing
// feature contributes nothing (missing data never raises a score). Then gates: an exclusion gives tier X and 0, a
// cap lowers the score; `do_not_contact` always excludes, whatever the profile says. Tiers: A from `tiers.A`, B from
// `tiers.B`, else C.

/** The engine's own gate: a business the workspace must not contact is never a prospect. */
export const DO_NOT_CONTACT_GATE: Gate = {
  id: 'do_not_contact',
  when: { feature: 'do_not_contact', eq: true },
  effect: { type: 'exclude' },
  reason: { en: 'Marked do-not-contact.', fr: 'Marquée à ne pas contacter.' },
};

const ORDER = new Map(FEATURE_KEYS.map((key, index) => [key, index]));
const round = (value: number) => Math.round(value * 10_000) / 10_000;

export function scoreVector(config: ScoringProfileConfig, vector: FeatureVector): ScoreResult {
  const weighted = FEATURE_KEYS.filter((key) => (config.weights[key] ?? 0) !== 0).sort(
    (a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0),
  );
  const positive = weighted.reduce((sum, key) => sum + Math.max(0, config.weights[key] ?? 0), 0);
  const contributions: ScoreContribution[] = weighted.map((feature) => {
    const weight = config.weights[feature] ?? 0;
    const rawValue = vector[feature] ?? null;
    const transformed = applyTransform(config.transforms[feature], rawValue);
    return {
      feature,
      rawValue,
      transformed: transformed === null ? null : round(transformed),
      weight,
      contribution:
        transformed === null || positive === 0 ? 0 : round((100 * weight * transformed) / positive),
    };
  });
  const total = contributions.reduce((sum, { contribution }) => sum + contribution, 0);
  let score = Math.round(Math.min(100, Math.max(0, total)));
  const gate = decidingGate([DO_NOT_CONTACT_GATE, ...config.gates], vector);
  if (gate?.effect.type === 'exclude') score = 0;
  else if (gate?.effect.type === 'cap') score = Math.min(score, gate.effect.max);
  return {
    score,
    tier:
      gate?.effect.type === 'exclude'
        ? 'X'
        : score >= config.tiers.A
          ? 'A'
          : score >= config.tiers.B
            ? 'B'
            : 'C',
    contributions,
    reasons: selectReasons(config, contributions),
    gated: gate ? { gate: gate.id, effect: gate.effect.type, reason: gate.reason } : null,
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
