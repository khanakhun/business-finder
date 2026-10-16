import { describe, expect, it } from 'vitest';
import { parsePoints } from './transforms.tsx';

describe('parsePoints', () => {
  it('reads value:measure pairs, decimal comma allowed', () => {
    expect(parsePoints('0:0 10:0,5  50:1')).toEqual([
      [0, 0],
      [10, 0.5],
      [50, 1],
    ]);
  });

  it.each(['', '0:0', '0:0 10', '0:0 a:1', '0:0:1 2:3'])('refuses %j until it is complete', (text) =>
    expect(parsePoints(text)).toBeNull(),
  );
});
