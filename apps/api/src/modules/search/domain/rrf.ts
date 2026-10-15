// Reciprocal Rank Fusion (Cormack et al., SIGIR 2009): each ranker contributes 1 / (k + rank) for every id it
// returns; ids found by several rankers rise. Pure: ties break by id so pages are stable.

export interface Fused {
  readonly id: string;
  readonly score: number;
}

export const RRF_K = 60;

export function fuseRankings(rankings: ReadonlyArray<readonly string[]>, k: number = RRF_K): Fused[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    const seen = new Set<string>();
    for (const [index, id] of ranking.entries()) {
      // A ranker listing an id twice counts it once, at its best rank.
      if (seen.has(id)) continue;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    }
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
