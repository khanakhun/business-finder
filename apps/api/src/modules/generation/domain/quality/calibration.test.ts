import { describe, expect, it } from 'vitest';
import { bestThreshold, spearman } from './calibration.ts';

describe('critic calibration', () => {
  it('computes Spearman’s rank correlation, with ties averaged', () => {
    expect(spearman([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])).toBeCloseTo(1, 10);
    expect(spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])).toBeCloseTo(-1, 10);
    // With ties: ranks of [1,2,2,3] are [1, 2.5, 2.5, 4].
    expect(spearman([1, 2, 2, 3], [1, 3, 2, 4])).toBeCloseTo(0.9487, 3);
    expect(spearman([1, 2], [1, 2])).toBeNull();
    expect(spearman([3, 3, 3], [1, 2, 3])).toBeNull();
  });

  it('picks the critic threshold that best separates the sites people accept', () => {
    const pairs = [
      { critic: 4.2, human: 4.5 },
      { critic: 3.9, human: 4 },
      { critic: 3.7, human: 3.5 },
      { critic: 3.4, human: 3 },
      { critic: 2.9, human: 2.5 },
      { critic: 3.1, human: 2 },
    ];
    expect(bestThreshold(pairs)).toEqual({ threshold: 3.5, balancedAccuracy: 1 });
    expect(bestThreshold(pairs.filter((pair) => pair.human >= 3.5))).toBeNull();
  });
});
