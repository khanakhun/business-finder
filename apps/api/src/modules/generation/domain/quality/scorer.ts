import type { QualityGateId, QualityGateResult } from '@bf/contracts';

// The 0–100 quality score (BF-045, Strategy): schema, facts and claims are gates, not weights — failing one caps the
// score; the rest is a weighted average over the components that ran (copy, accessibility, performance, the visual
// rubric), re-weighted when some did not run (a pipeline without the sandboxed audits yet).

export const SCORE_WEIGHTS: Readonly<Partial<Record<QualityGateId, number>>> = {
  copy: 0.2,
  a11y: 0.25,
  performance: 0.25,
  visual: 0.3,
};
/** The most a version failing a hard gate (schema, facts, claims) can score. */
export const HARD_GATE_CAP = 40;
const HARD_GATES: readonly QualityGateId[] = ['schema', 'facts', 'claims'];

export function qualityScore(gates: readonly QualityGateResult[]): number {
  let weighted = 0;
  let weights = 0;
  for (const gate of gates) {
    const weight = SCORE_WEIGHTS[gate.id];
    if (
      weight === undefined ||
      gate.score === undefined ||
      gate.status === 'skipped' ||
      gate.status === 'error'
    )
      continue;
    weighted += weight * gate.score;
    weights += weight;
  }
  const score = weights > 0 ? weighted / weights : 100;
  const hardFailure = gates.some(
    (gate) => HARD_GATES.includes(gate.id) && gate.status !== 'pass' && gate.status !== 'skipped',
  );
  return Math.round(hardFailure ? Math.min(score, HARD_GATE_CAP) : score);
}
