import { describe, expect, it } from 'vitest';
import { hasText, parseSort, sortName } from './listing.ts';
import { fuseRankings, RRF_K } from './rrf.ts';

describe('fuseRankings (RRF)', () => {
  it('sums 1 / (k + rank) across rankers, so ids found by several rise', () => {
    const fused = fuseRankings([
      ['a', 'b', 'c'],
      ['c', 'a'],
      ['d', 'c'],
    ]);
    expect(fused.map((f) => f.id)).toEqual(['c', 'a', 'd', 'b']);
    expect(fused[0]?.score).toBeCloseTo(1 / (RRF_K + 3) + 1 / (RRF_K + 1) + 1 / (RRF_K + 2));
  });

  it('breaks ties by id, ignores empty and duplicate entries', () => {
    expect(fuseRankings([['b'], ['a'], []]).map((f) => f.id)).toEqual(['a', 'b']);
    expect(fuseRankings([['a', 'a', 'b']])).toEqual([
      { id: 'a', score: 1 / (RRF_K + 1) },
      { id: 'b', score: 1 / (RRF_K + 3) },
    ]);
    expect(fuseRankings([])).toEqual([]);
  });
});

describe('listing sorts', () => {
  it.each([
    [undefined, false, 'recent', 'desc'],
    [undefined, true, 'relevance', 'desc'],
    ['relevance', false, 'recent', 'desc'],
    ['-score', true, 'score', 'desc'],
    ['rating', false, 'rating', 'asc'],
    ['distance', false, 'distance', 'asc'],
    ['name', false, 'name', 'asc'],
  ] as const)('%s (text: %s) → %s %s', (sort, text, key, direction) => {
    const parsed = parseSort(sort, text);
    expect(parsed).toEqual({ key, direction });
    if (sort && sort !== 'relevance') expect(sortName(parsed)).toBe(sort);
  });

  it('treats a query or keywords as text', () => {
    expect(hasText({ q: 'spa' } as never)).toBe(true);
    expect(hasText({ keyword: ['vegan'] } as never)).toBe(true);
    expect(hasText({ keyword: [] } as never)).toBe(false);
  });
});
