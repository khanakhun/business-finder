import type { Transform } from '@bf/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyTransform } from './transforms.ts';

describe('transforms', () => {
  it('maps each kind onto 0–1 and clamps outside the range', () => {
    const linear: Transform = { kind: 'linear', min: 10, max: 20 };
    expect([5, 10, 15, 20, 25].map((x) => applyTransform(linear, x))).toEqual([0, 0, 0.5, 1, 1]);
    const inverse: Transform = { kind: 'inverse', min: 0, max: 100 };
    expect([-5, 25, 100, 150].map((x) => applyTransform(inverse, x))).toEqual([1, 0.75, 0, 0]);
    const piecewise: Transform = {
      kind: 'piecewise',
      points: [
        [0, 0],
        [2, 0.8],
        [4, 1],
      ],
    };
    expect([-1, 1, 2, 3, 9].map((x) => applyTransform(piecewise, x))).toEqual([0, 0.4, 0.8, 0.9, 1]);
    const log: Transform = { kind: 'log', max: 999 };
    expect(applyTransform(log, 0)).toBe(0);
    expect(applyTransform(log, 999)).toBe(1);
    expect(applyTransform(log, 99)).toBeCloseTo(2 / 3, 6);
    // Interpolation is exact between points.
    expect(
      applyTransform(
        {
          kind: 'piecewise',
          points: [
            [10, 0.2],
            [20, 0.6],
          ],
        },
        12.5,
      ),
    ).toBeCloseTo(0.3, 10);
    expect(applyTransform({ kind: 'boolean', true: 0.2, false: 0.9 }, true)).toBe(0.2);
    expect(applyTransform({ kind: 'boolean', true: 0.2, false: 0.9 }, false)).toBe(0.9);
    const map: Transform = { kind: 'enumMap', map: { none: 1, weak: 0.5 }, default: 0.1 };
    expect(['none', 'weak', 'strong'].map((x) => applyTransform(map, x))).toEqual([1, 0.5, 0.1]);
  });

  it('reads missing or mismatched values as missing; defaults booleans and 0–1 numbers', () => {
    expect(applyTransform({ kind: 'linear', min: 0, max: 1 }, null)).toBeNull();
    expect(applyTransform({ kind: 'linear', min: 0, max: 1 }, 'weak')).toBeNull();
    expect(applyTransform({ kind: 'boolean', true: 1, false: 0 }, 3)).toBeNull();
    expect(applyTransform({ kind: 'enumMap', map: {}, default: 0 }, 3)).toBeNull();
    expect(applyTransform(undefined, true)).toBe(1);
    expect(applyTransform(undefined, false)).toBe(0);
    expect(applyTransform(undefined, 0.35)).toBe(0.35);
    expect(applyTransform(undefined, 7)).toBe(1);
    expect(applyTransform(undefined, 'ok')).toBeNull();
  });

  it('is monotone: linear, piecewise and log never decrease, inverse never increases', () => {
    const pair = fc.tuple(
      fc.double({ min: -1e4, max: 1e4, noNaN: true }),
      fc.double({ min: 0, max: 1e4, noNaN: true }),
    );
    const transforms: Transform[] = [
      { kind: 'linear', min: -50, max: 300 },
      {
        kind: 'piecewise',
        points: [
          [0, 0.1],
          [5, 0.3],
          [10, 0.3],
          [20, 1],
        ],
      },
      { kind: 'log', max: 500 },
    ];
    fc.assert(
      fc.property(pair, ([x, delta]) => {
        for (const transform of transforms) {
          expect(applyTransform(transform, x + delta)).toBeGreaterThanOrEqual(
            applyTransform(transform, x) ?? 0,
          );
        }
        const inverse: Transform = { kind: 'inverse', min: -50, max: 300 };
        expect(applyTransform(inverse, x + delta)).toBeLessThanOrEqual(applyTransform(inverse, x) ?? 1);
      }),
      { seed: Number(process.env.FC_SEED ?? 20_261_016) },
    );
  });
});
