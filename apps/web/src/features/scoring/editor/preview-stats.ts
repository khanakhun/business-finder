import type { ScoreTier } from '@bf/contracts';

// Live preview statistics (BF-032), computed in the browser over at most 200 businesses: tier counts, rank
// correlation, the businesses that move most, and the tier movement between two versions. The scores themselves
// always come from the server's engine (batch explain).

export const TIERS: readonly ScoreTier[] = ['A', 'B', 'C', 'X'];

export interface Scored {
  readonly businessId: string;
  readonly score: number;
  readonly tier: ScoreTier;
}

export type TierCounts = Record<ScoreTier, number>;

export function tierCounts(items: readonly Scored[]): TierCounts {
  const counts: TierCounts = { A: 0, B: 0, C: 0, X: 0 };
  for (const item of items) counts[item.tier] += 1;
  return counts;
}

/** Rank 1 is the highest score; ties share their average rank. Ties break on nothing else. */
export function ranks(items: readonly Scored[]): Map<string, number> {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const result = new Map<string, number>();
  for (let start = 0; start < sorted.length; ) {
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1]?.score === sorted[start]?.score) end += 1;
    const rank = (start + end) / 2 + 1;
    for (let i = start; i <= end; i += 1) {
      const item = sorted[i];
      if (item) result.set(item.businessId, rank);
    }
    start = end + 1;
  }
  return result;
}

/**
 * Spearman's rank correlation over the businesses both lists score (Pearson's on average ranks, so ties are
 * handled); null with fewer than two businesses in common or no spread in either.
 */
export function spearman(a: readonly Scored[], b: readonly Scored[]): number | null {
  const inB = new Set(b.map((item) => item.businessId));
  const common = a.filter((item) => inB.has(item.businessId)).map((item) => item.businessId);
  if (common.length < 2) return null;
  const keep = new Set(common);
  const ra = ranks(a.filter((item) => keep.has(item.businessId)));
  const rb = ranks(b.filter((item) => keep.has(item.businessId)));
  const xs = common.map((id) => ra.get(id) ?? 0);
  const ys = common.map((id) => rb.get(id) ?? 0);
  const mean = (values: readonly number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
  const mx = mean(xs);
  const my = mean(ys);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = (xs[i] ?? 0) - mx;
    const dy = (ys[i] ?? 0) - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}

export interface Mover {
  readonly businessId: string;
  readonly fromRank: number;
  readonly toRank: number;
  /** Positive: moved up (a smaller rank number). */
  readonly change: number;
  readonly fromTier: ScoreTier;
  readonly toTier: ScoreTier;
  readonly fromScore: number;
  readonly toScore: number;
}

/** The businesses whose rank changes most between two scorings (ties: the bigger score change first). */
export function topMovers(before: readonly Scored[], after: readonly Scored[], limit: number): Mover[] {
  const byId = new Map(after.map((item) => [item.businessId, item]));
  const common = before.filter((item) => byId.has(item.businessId));
  const keep = new Set(common.map((item) => item.businessId));
  const rb = ranks(common);
  const ra = ranks(after.filter((item) => keep.has(item.businessId)));
  return common
    .map((item) => {
      const next = byId.get(item.businessId) as Scored;
      const fromRank = rb.get(item.businessId) ?? 0;
      const toRank = ra.get(item.businessId) ?? 0;
      return {
        businessId: item.businessId,
        fromRank,
        toRank,
        change: fromRank - toRank,
        fromTier: item.tier,
        toTier: next.tier,
        fromScore: item.score,
        toScore: next.score,
      };
    })
    .filter((mover) => mover.change !== 0 || mover.fromTier !== mover.toTier)
    .sort(
      (x, y) =>
        Math.abs(y.change) - Math.abs(x.change) ||
        Math.abs(y.toScore - y.fromScore) - Math.abs(x.toScore - x.fromScore),
    )
    .slice(0, limit);
}

export type TierMatrix = Record<ScoreTier, Record<ScoreTier, number>>;

/** How many businesses go from each tier (rows: `before`) to each tier (columns: `after`). */
export function tierMatrix(before: readonly Scored[], after: readonly Scored[]): TierMatrix {
  const matrix = Object.fromEntries(
    TIERS.map((from) => [from, Object.fromEntries(TIERS.map((to) => [to, 0]))]),
  ) as TierMatrix;
  const byId = new Map(after.map((item) => [item.businessId, item]));
  for (const item of before) {
    const next = byId.get(item.businessId);
    if (next) matrix[item.tier][next.tier] += 1;
  }
  return matrix;
}
