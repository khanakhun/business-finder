// Rank statistics for the prospective comparison and decay checks (BF-059).

/** Average ranks (1-based), ties sharing the mean of their positions. */
function ranks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const out = new Array<number>(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]?.value === order[i]?.value) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k]?.index ?? 0] = rank;
    i = j + 1;
  }
  return out;
}

/** Spearman's rank correlation (null under three pairs or a constant side). */
export function spearman(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length < 3) return null;
  const ra = ranks(a);
  const rb = ranks(b);
  const mean = (a.length + 1) / 2;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = (ra[i] ?? 0) - mean;
    const y = (rb[i] ?? 0) - mean;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da === 0 || db === 0 ? null : num / Math.sqrt(da * db);
}

/** ROC-AUC by the Mann–Whitney statistic (null without both classes). */
export function rocAuc(scores: readonly number[], labels: readonly (0 | 1)[]): number | null {
  const positives = labels.filter((label) => label === 1).length;
  const negatives = labels.length - positives;
  if (positives === 0 || negatives === 0) return null;
  const r = ranks(scores);
  const sum = labels.reduce<number>((total, label, i) => total + (label === 1 ? (r[i] ?? 0) : 0), 0);
  return (sum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/** The top `share` of items by score (ties broken by position), as indexes. */
export function topShare(scores: readonly number[], share: number): number[] {
  const k = Math.max(1, Math.ceil(scores.length * share));
  return scores
    .map((score, index) => ({ score, index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, k)
    .map((item) => item.index);
}
