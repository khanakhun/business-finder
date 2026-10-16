import { describe, expect, it } from 'vitest';
import { contrastRatio, luminance, suggestColor } from './contrast.ts';

describe('contrast', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // Known pairs: #767676 on white is the lightest grey passing AA (4.54:1); #777777 fails (4.48:1).
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.5);
    expect(luminance('#ffffff')).toBeCloseTo(1, 5);
    // Order does not matter.
    expect(contrastRatio('#336699', '#f0e6d2')).toBeCloseTo(contrastRatio('#f0e6d2', '#336699'), 10);
  });

  it('suggests the nearest passing colour, keeping one that passes', () => {
    const fixed = suggestColor('#999999', '#ffffff', 4.5);
    expect(fixed).not.toBeNull();
    expect(contrastRatio(fixed ?? '', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(suggestColor('#222222', '#ffffff', 4.5)).toBe('#222222');
    // On a mid grey, lightening or darkening both work: the nearer one wins.
    expect(suggestColor('#808080', '#808080', 3)).not.toBeNull();
    // 21:1 is only reachable by black on white.
    expect(suggestColor('#808080', '#808080', 22)).toBeNull();
  });
});
