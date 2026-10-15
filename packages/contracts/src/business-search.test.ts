import { describe, expect, it } from 'vitest';
import { BusinessFiltersSchema, BusinessSearchQuerySchema } from './business-search.ts';

const A = '0192a1b2-0000-7000-8000-000000000001';
const B = '0192a1b2-0000-7000-8000-000000000002';

describe('BusinessSearchQuerySchema', () => {
  it('reads repeated keys, comma lists, ranges, booleans and points from a query string', () => {
    const query = BusinessSearchQuerySchema.parse({
      category: [A, B],
      status: 'qualified,contacted',
      tag: 'vip',
      'rating[gte]': '4.5',
      'reviews[lte]': '20',
      hasEmail: 'false',
      near: '17.9, -62.85',
      price: '1,2',
      limit: '10',
    });
    expect(query).toMatchObject({
      category: [A, B],
      status: ['qualified', 'contacted'],
      tag: ['vip'],
      'rating[gte]': 4.5,
      'reviews[lte]': 20,
      hasEmail: false,
      near: { lat: 17.9, lng: -62.85 },
      radiusKm: 5,
      price: [1, 2],
      limit: 10,
      website: 'any',
    });
    expect(query.sort).toBeUndefined();
  });

  it.each([
    { status: 'nope' },
    { category: 'not-a-uuid' },
    { 'rating[gte]': '6' },
    { near: '91,0' },
    { near: 'gustavia' },
    { hasEmail: 'yes' },
    { sort: 'popularity' },
    { tag: Array.from({ length: 21 }, (_, i) => `t${i}`) },
    { price: '5' },
  ])('rejects %j', (input) => {
    expect(BusinessSearchQuerySchema.safeParse(input).success).toBe(false);
  });

  it('keeps filters free of paging and sort (what a saved search stores)', () => {
    expect(Object.keys(BusinessFiltersSchema.shape)).not.toContain('cursor');
    expect(Object.keys(BusinessFiltersSchema.shape)).not.toContain('sort');
  });
});

describe('SavedFiltersSchema', () => {
  it('accepts query-string filters and rejects unknown or invalid ones', async () => {
    const { SavedFiltersSchema } = await import('./saved-searches.ts');
    expect(SavedFiltersSchema.parse({ status: ['qualified'], q: 'spa' })).toEqual({
      status: ['qualified'],
      q: 'spa',
    });
    expect(SavedFiltersSchema.safeParse({ colour: 'red' }).success).toBe(false);
    expect(SavedFiltersSchema.safeParse({ status: 'nope' }).success).toBe(false);
    expect(SavedFiltersSchema.safeParse({ cursor: 'x' }).success).toBe(false);
  });
});
