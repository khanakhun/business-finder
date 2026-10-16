import { describe, expect, it } from 'vitest';
import { safeWebUrl } from './safe-url.ts';

describe('safeWebUrl', () => {
  it.each([
    ['https://cafe.example/', 'https://cafe.example/'],
    ['http://cafe.example', 'http://cafe.example/'],
    ['javascript:alert(1)', null],
    ['data:text/html,hi', null],
    ['not a url', null],
    [null, null],
  ])('%j → %j', (input, expected) => {
    expect(safeWebUrl(input)).toBe(expected);
  });
});
