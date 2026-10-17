import {
  FEATURE_KEYS,
  type FeatureKey,
  type FeatureVector,
  type ScoreContribution,
  type ScoreResult,
  type ScoringProfileConfig,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { applyGates } from '../../domain/engine.ts';
import { withDefaults } from '../../domain/features/registry.ts';
import { calibrate, inputRow, linearContributions } from '../../domain/ml/preprocessing.ts';
import { selectReasons } from '../../domain/reasons.ts';
import { type MlModelRecord, MODEL_RUNTIME, type ModelRuntime } from './ports.ts';

// Scoring with an outcome-trained model (BF-059): the business's feature vector plus the context of the decision
// being scored, through the model's spec and ONNX graph, calibrated; score = 100 × probability; tiers by
// probability; the profile's gates as for rules. Logistic regression explains exactly: a feature's points are its
// share of the logit times p·(1−p) (the probability change it makes, in points).

const KEYS = new Set<string>(FEATURE_KEYS);
const round = (value: number) => Math.round(value * 10_000) / 10_000;

export interface ModelScore extends ScoreResult {
  readonly probability: number;
}

// DECISION(BF-059): a business is scored for the decision ahead — a first email for the profile's offer, without a
// preview yet (whether a preview exists is not in the feature vector); the language is unknown.
export const decisionContext = (offer: string) => ({
  ctx_offer: offer,
  ctx_channel: 'email',
  ctx_locale: null,
  ctx_preview_built: false,
  ctx_preview_quality: null,
});

@Injectable()
export class ModelScoring {
  constructor(@Inject(MODEL_RUNTIME) private readonly runtime: ModelRuntime) {}

  /** Logistic regression's coefficients summed per feature (by absolute size); [] for other kinds. */
  async importance(model: MlModelRecord): Promise<{ feature: string; weight: number }[]> {
    const spec = await this.runtime.spec(model);
    if (!spec.linear) return [];
    const weights = new Map<string, number>();
    for (const [j, column] of spec.columns.entries())
      weights.set(column.source, (weights.get(column.source) ?? 0) + (spec.linear.coefficients[j] ?? 0));
    return [...weights.entries()]
      .map(([feature, weight]) => ({ feature, weight: round(weight) }))
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  }

  async score(
    model: MlModelRecord,
    config: ScoringProfileConfig,
    vectors: readonly FeatureVector[],
    tiers: { readonly A: number; readonly B: number },
  ): Promise<ModelScore[]> {
    if (vectors.length === 0) return [];
    const spec = await this.runtime.spec(model);
    const rows = vectors.map((vector) => inputRow(spec, { ...vector, ...decisionContext(config.offer) }));
    const raw = await this.runtime.predict(model, rows);
    return vectors.map((vector, i) => {
      const probability = calibrate(spec.calibration, raw[i] ?? 0);
      const computed = Math.round(Math.min(100, Math.max(0, probability * 100)));
      const { score, excluded, gated } = applyGates(config, withDefaults(vector), computed);
      const effective = score / 100;
      const tier = excluded
        ? 'X'
        : Math.min(probability, effective) >= tiers.A
          ? 'A'
          : Math.min(probability, effective) >= tiers.B
            ? 'B'
            : 'C';
      const linear = linearContributions(spec, rows[i] ?? new Float32Array());
      const slope = probability * (1 - probability) * 100;
      const contributions: ScoreContribution[] = linear
        ? [...linear.entries()]
            .filter(([feature]) => KEYS.has(feature))
            .map(([feature, logit]) => ({
              feature: feature as FeatureKey,
              rawValue: vector[feature as FeatureKey] ?? null,
              transformed: null,
              imputed: null,
              weight: 0,
              contribution: round(slope * logit),
            }))
            .filter((contribution) => contribution.contribution !== 0)
        : [];
      return {
        probability,
        score,
        tier,
        contributions,
        reasons: excluded ? [] : selectReasons(config, contributions),
        gated,
      };
    });
  }
}
