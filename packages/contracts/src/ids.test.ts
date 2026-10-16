import { describe, expect, expectTypeOf, it } from 'vitest';
import { BusinessId, type Id, isUuidV7, newId, OrgId, type SiteId } from './ids.ts';

describe('newId', () => {
  it('produces RFC 9562 UUIDv7 strings', () => {
    const id = newId();
    expect(isUuidV7(id)).toBe(true);
    expect(BusinessId.safeParse(id).success).toBe(true);
  });

  it('is monotonic, even within the same millisecond', () => {
    const ids = Array.from({ length: 10_000 }, () => newId());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('isUuidV7', () => {
  it.each([
    ['0192f3e4-5b6c-7d8e-9f01-23456789abcd', true],
    ['0192F3E4-5B6C-7D8E-9F01-23456789ABCD', true],
    ['0192f3e4-5b6c-4d8e-9f01-23456789abcd', false], // v4
    ['0192f3e4-5b6c-7d8e-cf01-23456789abcd', false], // bad variant
    ['not-a-uuid', false],
  ])('%s → %s', (value, expected) => {
    expect(isUuidV7(value)).toBe(expected);
  });
});

describe('branded ids', () => {
  it('keep their description for API docs', () => {
    expect(BusinessId.description).toBe('BusinessId (UUID)');
  });

  it('parse UUIDs and reject anything else', () => {
    expect(OrgId.safeParse('0192f3e4-5b6c-7d8e-9f01-23456789abcd').success).toBe(true);
    expect(OrgId.safeParse('123').success).toBe(false);
  });

  it('are not interchangeable at compile time', () => {
    // Assignability is what matters; expectTypeOf's equality helpers mis-handle Zod brand intersections.
    const business: BusinessId = BusinessId.parse(newId());
    // @ts-expect-error a BusinessId is not a SiteId
    const site: SiteId = business;
    expect(site).toBe(business);
    expectTypeOf<BusinessId>().not.toExtend<SiteId>();
    // @ts-expect-error a plain string is not a BusinessId without parsing
    const unparsed: BusinessId = 'not-parsed';
    expect(unparsed).toBe('not-parsed');
    expectTypeOf<BusinessId>().toExtend<string>();
    expectTypeOf(newId<'SiteId'>()).toEqualTypeOf<Id<'SiteId'>>();
    expectTypeOf<Id<'SiteId'>>().toEqualTypeOf<SiteId>();
  });
});
