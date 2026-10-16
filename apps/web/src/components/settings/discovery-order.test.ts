import { describe, expect, it } from 'vitest';
import { moveProvider } from './discovery-order.ts';

describe('moveProvider', () => {
  const order = ['overture', 'foursquare', 'osm', 'google_places'] as const;

  it('moves a provider up or down by one', () => {
    expect(moveProvider(order, 2, -1)).toEqual(['overture', 'osm', 'foursquare', 'google_places']);
    expect(moveProvider(order, 0, 1)).toEqual(['foursquare', 'overture', 'osm', 'google_places']);
  });

  it('stays within the list and leaves the input untouched', () => {
    expect(moveProvider(order, 0, -1)).toEqual([...order]);
    expect(moveProvider(order, 3, 1)).toEqual([...order]);
    expect(order[0]).toBe('overture');
  });
});
