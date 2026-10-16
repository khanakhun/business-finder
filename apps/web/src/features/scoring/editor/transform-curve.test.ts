import { describe, expect, it } from 'vitest';
import { transformCurve } from './transform-curve.ts';

describe('transformCurve', () => {
  it('samples linear, inverse, log and piecewise transforms on 0–1, flat outside their bounds', () => {
    const linear = transformCurve({ kind: 'linear', min: 0, max: 10 }, 4) ?? [];
    expect(linear[0]).toEqual([-1.5, 0]);
    expect(linear.at(-1)).toEqual([11.5, 1]);
    const inverse = transformCurve({ kind: 'inverse', min: 0, max: 10 }, 2) ?? [];
    expect(inverse.map(([, y]) => y)).toEqual([1, 0.5, 0]);
    const log = transformCurve({ kind: 'log', max: 100 }, 10) ?? [];
    expect(log.every(([, y]) => y >= 0 && y <= 1)).toBe(true);
    const piecewise =
      transformCurve(
        {
          kind: 'piecewise',
          points: [
            [0, 0],
            [10, 0.8],
            [20, 1],
          ],
        },
        6,
      ) ?? [];
    expect(piecewise.map(([, y]) => Math.round(y * 100) / 100)).toEqual([0, 0.11, 0.45, 0.8, 0.89, 0.97, 1]);
  });

  it('has no curve for boolean and enum transforms', () => {
    expect(transformCurve({ kind: 'boolean', true: 1, false: 0 })).toBeNull();
    expect(transformCurve({ kind: 'enumMap', map: { a: 1 }, default: 0 })).toBeNull();
  });
});
