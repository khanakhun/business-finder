import { describe, expect, it } from 'vitest';
import { move, moveById } from './reorder.ts';

describe('reorder', () => {
  it('moves an item up, down and to the ends, clamped', () => {
    expect(move(['a', 'b', 'c', 'd'], 2, 0)).toEqual(['c', 'a', 'b', 'd']);
    expect(move(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(move(['a', 'b', 'c'], 1, 9)).toEqual(['a', 'c', 'b']);
    expect(move(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(move(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });

  it('moves by id onto another item’s position', () => {
    const items = [{ id: 'salon' }, { id: 'hardware' }, { id: 'cafe' }];
    expect(moveById(items, 'cafe', 'salon').map((item) => item.id)).toEqual(['cafe', 'salon', 'hardware']);
    expect(moveById(items, 'cafe', 'missing').map((item) => item.id)).toEqual(['salon', 'hardware', 'cafe']);
  });
});
