import { BusinessFiltersSchema } from '@bf/contracts';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { ListingSpec } from '../../domain/listing.ts';
import { filterSql, keysetSql, orderSql, sortKeySql } from './business-search.sql.ts';

// Snapshot of the SQL each filter generates (BF-022): values are always bound parameters.
const dialect = new PgDialect({ casing: 'snake_case' }); // as the app's client (packages/db client.ts)
const ORG = '0192a1b2-0000-7000-8000-0000000000aa';
const ID = '0192a1b2-0000-7000-8000-000000000001';

const spec = (filters: Record<string, unknown>, extra: Partial<ListingSpec> = {}): ListingSpec => ({
  organizationId: ORG,
  filters: BusinessFiltersSchema.parse(filters),
  text: null,
  origin: null,
  addedSince: null,
  ...extra,
});
const render = (s: ListingSpec, omit?: Parameters<typeof filterSql>[1]) =>
  dialect.sqlToQuery(filterSql(s, omit));

describe('filterSql', () => {
  it('scopes to the workspace, live records and open businesses by default', () => {
    expect(render(spec({}))).toMatchSnapshot();
    expect(render(spec({ includeClosed: 'true' })).sql).not.toContain('closed_permanently');
  });

  it.each([
    ['category', { category: ID }],
    ['area', { area: ID }],
    ['near', { near: '17.9,-62.85', radiusKm: '2' }],
    ['country', { country: 'BL' }],
    ['website none', { website: 'none' }],
    ['website weak', { website: 'weak' }],
    ['ratings', { 'rating[gte]': '3.5', 'rating[lte]': '4.5' }],
    ['reviews', { 'reviews[gte]': '10', 'reviews[lte]': '50' }],
    ['scores', { 'score[gte]': '60', 'score[lte]': '90' }],
    ['price', { price: '1,2' }],
    ['email', { hasEmail: 'true', emailVerified: 'false' }],
    ['no email', { hasEmail: 'false' }],
    ['phone', { hasPhone: 'false' }],
    ['status', { status: 'qualified,won' }],
    ['tier', { tier: 'A' }],
    ['tag', { tag: 'vip' }],
    ['owner', { owner: ID }],
  ])('%s', (_name, filters) => {
    const query = render(spec(filters));
    expect(query).toMatchSnapshot();
    // Every caller-supplied value is a parameter.
    for (const value of Object.values(filters).flatMap((v) => String(v).split(','))) {
      if (value.length >= 3) expect(query.sql).not.toContain(value);
    }
  });

  it('adds recency and keyword conditions from the resolved spec', () => {
    const query = render(
      spec({}, { addedSince: new Date('2026-10-01T00:00:00Z'), text: { q: null, keywords: ['vegan'] } }),
    );
    expect(query).toMatchSnapshot();
  });

  it('drops only the faceted dimension', () => {
    const filters = { status: 'qualified', tier: 'A', website: 'none', hasEmail: 'true', 'rating[gte]': '4' };
    expect(render(spec(filters), 'status').params).not.toContain('qualified');
    expect(render(spec(filters), 'status').params).toContain('A');
    expect(render(spec(filters), 'tier').params).not.toContain('A');
    expect(render(spec(filters), 'website').sql).not.toContain('"website_url" IS NULL');
    expect(render(spec(filters), 'rating').params).not.toContain(4);
  });
});

describe('sort and keyset', () => {
  it('orders nulls last with an id tie-breaker in the same direction', () => {
    const sort = { key: 'score', direction: 'desc' } as const;
    const key = sortKeySql(sort, null);
    expect(dialect.sqlToQuery(orderSql(key, sort)).sql).toBe(
      '"org_businesses"."score" DESC NULLS LAST, "businesses"."id" DESC NULLS LAST',
    );
    expect(dialect.sqlToQuery(keysetSql(key, sort, { sort: '-score', value: 40, id: ID }))).toMatchSnapshot();
    expect(dialect.sqlToQuery(keysetSql(key, sort, { sort: '-score', value: null, id: ID })).sql).toBe(
      '("org_businesses"."score" IS NULL AND "businesses"."id" < $1::uuid)',
    );
  });

  it('uses a row comparison for keys that are never null', () => {
    const sort = { key: 'recent', direction: 'desc' } as const;
    const key = sortKeySql(sort, null);
    expect(
      dialect.sqlToQuery(
        keysetSql(key, sort, { sort: '-recent', value: '2026-10-14T10:00:00.000000Z', id: ID }),
      ).sql,
    ).toBe('("org_businesses"."created_at", "businesses"."id") < ($1::timestamptz, $2::uuid)');
  });

  it('measures distance from the origin and refuses relevance', () => {
    const key = sortKeySql({ key: 'distance', direction: 'asc' }, { lat: 17.9, lng: -62.85 });
    expect(dialect.sqlToQuery(key.expr).params).toEqual([-62.85, 17.9]);
    expect(() => sortKeySql({ key: 'distance', direction: 'asc' }, null)).toThrow(/origin/);
    expect(() => sortKeySql({ key: 'relevance', direction: 'desc' }, null)).toThrow(/RRF/);
  });
});
