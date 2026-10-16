import { describe, expect, it } from 'vitest';
import { ranks, type Scored, spearman, tierCounts, tierMatrix, topMovers } from './preview-stats.ts';

const s = (businessId: string, score: number, tier: Scored['tier'] = 'B'): Scored => ({
  businessId,
  score,
  tier,
});

describe('preview statistics', () => {
  it('counts tiers', () => {
    expect(tierCounts([s('a', 80, 'A'), s('b', 50), s('c', 40), s('x', 0, 'X')])).toEqual({
      A: 1,
      B: 2,
      C: 0,
      X: 1,
    });
  });

  it('ranks highest first, ties sharing their average rank', () => {
    expect(Object.fromEntries(ranks([s('a', 10), s('b', 30), s('c', 30), s('d', 5)]))).toEqual({
      b: 1.5,
      c: 1.5,
      a: 3,
      d: 4,
    });
  });

  it('correlates ranks: same order 1, reversed −1, unrelated in between, too little data null', () => {
    const base = [s('a', 90), s('b', 70), s('c', 50), s('d', 30)];
    expect(spearman(base, [s('a', 60), s('b', 50), s('c', 40), s('d', 10)])).toBeCloseTo(1);
    expect(spearman(base, [s('a', 10), s('b', 30), s('c', 50), s('d', 70)])).toBeCloseTo(-1);
    // Classic example: ranks (1,2,3,4) vs (2,1,4,3) → 1 − 6·4 / (4·15) = 0.6.
    expect(spearman(base, [s('a', 70), s('b', 90), s('c', 30), s('d', 50)])).toBeCloseTo(0.6);
    expect(spearman(base, [s('a', 1)])).toBeNull();
    expect(
      spearman(
        base,
        base.map((item) => s(item.businessId, 5)),
      ),
    ).toBeNull();
    // Only businesses in both count.
    expect(spearman([...base, s('e', 1)], [s('a', 9), s('b', 8)])).toBeCloseTo(1);
  });

  it('lists the biggest rank changes first, with tiers and scores', () => {
    const before = [s('a', 90, 'A'), s('b', 70), s('c', 50), s('d', 30, 'C')];
    const after = [s('a', 40), s('b', 70), s('c', 50), s('d', 95, 'A')];
    expect(topMovers(before, after, 2)).toEqual([
      {
        businessId: 'd',
        fromRank: 4,
        toRank: 1,
        change: 3,
        fromTier: 'C',
        toTier: 'A',
        fromScore: 30,
        toScore: 95,
      },
      {
        businessId: 'a',
        fromRank: 1,
        toRank: 4,
        change: -3,
        fromTier: 'A',
        toTier: 'B',
        fromScore: 90,
        toScore: 40,
      },
    ]);
    expect(topMovers(before, before, 5)).toEqual([]);
  });

  it('counts tier movements between two scorings, X included', () => {
    const matrix = tierMatrix(
      [s('a', 90, 'A'), s('b', 50), s('c', 0, 'X')],
      [s('a', 50), s('b', 50), s('c', 70, 'A')],
    );
    expect(matrix.A).toEqual({ A: 0, B: 1, C: 0, X: 0 });
    expect(matrix.B.B).toBe(1);
    expect(matrix.X.A).toBe(1);
  });
});
