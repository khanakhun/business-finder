// Calibrating the visual critic (BF-045): how well its grades agree with people's on the same sites (Spearman's rank
// correlation, ties averaged), and which pass threshold best separates the sites people found acceptable.

/** Ranks with ties averaged (1-based). */
function ranks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = new Array<number>(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]?.value === order[i]?.value) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) result[order[k]?.index as number] = rank;
    i = j + 1;
  }
  return result;
}

/** Spearman's ρ between two paired series (null with fewer than 3 pairs or no variance). */
export function spearman(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length < 3) return null;
  const ra = ranks(a);
  const rb = ranks(b);
  const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
  const ma = mean(ra);
  const mb = mean(rb);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < ra.length; i++) {
    const da = (ra[i] as number) - ma;
    const db = (rb[i] as number) - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  return va === 0 || vb === 0 ? null : cov / Math.sqrt(va * vb);
}

/**
 * The critic average that best separates the sites people accept (human overall ≥ `acceptable`) from the rest:
 * the threshold with the highest balanced accuracy, among 2.5–4.5 in steps of 0.1.
 */
export function bestThreshold(
  pairs: readonly { readonly critic: number; readonly human: number }[],
  acceptable = 3.5,
): { readonly threshold: number; readonly balancedAccuracy: number } | null {
  const good = pairs.filter((pair) => pair.human >= acceptable);
  const bad = pairs.filter((pair) => pair.human < acceptable);
  if (good.length === 0 || bad.length === 0) return null;
  let best = { threshold: 3.5, balancedAccuracy: -1 };
  for (let step = 25; step <= 45; step++) {
    const threshold = step / 10;
    const tpr = good.filter((pair) => pair.critic >= threshold).length / good.length;
    const tnr = bad.filter((pair) => pair.critic < threshold).length / bad.length;
    const balancedAccuracy = (tpr + tnr) / 2;
    if (balancedAccuracy > best.balancedAccuracy) best = { threshold, balancedAccuracy };
  }
  return best;
}
