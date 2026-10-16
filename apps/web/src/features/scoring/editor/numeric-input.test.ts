import { describe, expect, it } from 'vitest';
import { parseNumber } from './numeric-input.tsx';

describe('parseNumber', () => {
  it.each([
    ['12', 12],
    ['-100', -100],
    ['0,5', 0.5],
    ['3.25', 3.25],
    ['.5', 0.5],
    ['10.', 10],
  ])('reads %s', (text, value) => expect(parseNumber(text)).toBe(value));

  it.each(['', '-', 'abc', '1e3', '0x10', '1,2,3', '--1'])('refuses %j while typing', (text) =>
    expect(parseNumber(text)).toBeNull(),
  );
});
