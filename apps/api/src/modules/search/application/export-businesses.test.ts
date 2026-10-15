import { describe, expect, it } from 'vitest';
import { csvCell } from './export-businesses.ts';

describe('csvCell', () => {
  it.each([
    [null, ''],
    [undefined, ''],
    [4.5, '4.5'],
    [-62.85, '-62.85'],
    ['Café des Arts', 'Café des Arts'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['line\nbreak', '"line\nbreak"'],
    ['=SUM(A1)', "'=SUM(A1)"],
    ['+33 1', "'+33 1"],
    ['-2', "'-2"],
    ['@cmd', "'@cmd"],
    ['\tx', "'\tx"],
    ['=HYPERLINK("x"),y', `"'=HYPERLINK(""x""),y"`],
  ])('%j → %j', (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });
});
