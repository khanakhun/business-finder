// Drift (BF-059): the Population Stability Index between a feature's training distribution and its recent one.
// PSI = Σ (recent% − train%) × ln(recent% / train%) over shared bins; under 0.1 is stable, 0.1–0.25 a moderate
// shift, over 0.25 a significant one (alert). Empty bins get a small floor so the logarithm stays finite.

const FLOOR = 1e-4;

/** PSI of two histograms over the same bins (counts, not shares). */
export function psi(train: readonly number[], recent: readonly number[]): number {
  if (train.length !== recent.length) throw new Error('PSI needs the same bins on both sides');
  const totalTrain = train.reduce((a, b) => a + b, 0);
  const totalRecent = recent.reduce((a, b) => a + b, 0);
  if (totalTrain === 0 || totalRecent === 0) return 0;
  let sum = 0;
  for (let i = 0; i < train.length; i++) {
    const p = Math.max((train[i] ?? 0) / totalTrain, FLOOR);
    const q = Math.max((recent[i] ?? 0) / totalRecent, FLOOR);
    sum += (q - p) * Math.log(q / p);
  }
  return sum;
}

/** Bin edges from training quantiles (deciles by default), deduplicated for discrete features. */
export function quantileEdges(values: readonly number[], bins = 10): number[] {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const edges: number[] = [];
  for (let i = 1; i < bins; i++) {
    const edge = sorted[Math.min(sorted.length - 1, Math.floor((i * sorted.length) / bins))] as number;
    if (edges.at(-1) !== edge) edges.push(edge);
  }
  return edges;
}

/** Counts per bin: `(-∞, e0], (e0, e1], …, (eN, ∞)`. */
export function histogram(values: readonly number[], edges: readonly number[]): number[] {
  const counts = new Array<number>(edges.length + 1).fill(0);
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    let bin = edges.findIndex((edge) => value <= edge);
    if (bin === -1) bin = edges.length;
    counts[bin] = (counts[bin] ?? 0) + 1;
  }
  return counts;
}

export const PSI_ALERT = 0.25;
export const AUC_DROP_ALERT = 0.05;
