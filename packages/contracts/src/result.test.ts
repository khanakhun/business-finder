import { describe, expect, expectTypeOf, it } from 'vitest';
import { andThen, err, fromPromise, isErr, isOk, map, mapErr, ok, type Result, unwrapOr } from './result.ts';

const parse = (s: string): Result<number, 'NAN'> => (Number.isNaN(Number(s)) ? err('NAN') : ok(Number(s)));

describe('Result', () => {
  it('narrows on ok / isOk / isErr', () => {
    const r = parse('4');
    if (r.ok) expectTypeOf(r.value).toEqualTypeOf<number>();
    else expectTypeOf(r.error).toEqualTypeOf<'NAN'>();
    expect(isOk(r)).toBe(true);
    expect(isErr(parse('x'))).toBe(true);
  });

  it('map transforms values and passes errors through', () => {
    expect(map(parse('4'), (n) => n * 2)).toEqual(ok(8));
    expect(map(parse('x'), (n) => n * 2)).toEqual(err('NAN'));
  });

  it('mapErr transforms errors and passes values through', () => {
    expect(mapErr(parse('x'), (e) => `bad: ${e}`)).toEqual(err('bad: NAN'));
    expect(mapErr(parse('1'), (e) => `bad: ${e}`)).toEqual(ok(1));
  });

  it('andThen chains and short-circuits', () => {
    const positive = (n: number): Result<number, 'NEGATIVE'> => (n >= 0 ? ok(n) : err('NEGATIVE'));
    const chained = andThen(parse('-1'), positive);
    expectTypeOf(chained).toEqualTypeOf<Result<number, 'NAN' | 'NEGATIVE'>>();
    expect(chained).toEqual(err('NEGATIVE'));
    expect(andThen(parse('x'), positive)).toEqual(err('NAN'));
    expect(andThen(parse('3'), positive)).toEqual(ok(3));
  });

  it('unwrapOr falls back on errors only', () => {
    expect(unwrapOr(parse('x'), 0)).toBe(0);
    expect(unwrapOr(parse('7'), 0)).toBe(7);
  });

  it('fromPromise settles into a Result', async () => {
    expect(await fromPromise(Promise.resolve(1))).toEqual(ok(1));
    expect(await fromPromise(Promise.reject(new Error('x')), (e) => (e as Error).message)).toEqual(err('x'));
    const raw = await fromPromise(Promise.reject('reason'));
    expect(raw).toEqual(err('reason'));
  });
});
