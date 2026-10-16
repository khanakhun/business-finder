import { describe, expect, it } from 'vitest';
import { FINDING_CODES, FINDING_DEFINITIONS, metricRating } from './website-audit.ts';

describe('findings registry', () => {
  it('has EN and FR title, explanation and recommendation for every finding', () => {
    expect(FINDING_CODES.length).toBeGreaterThanOrEqual(20);
    for (const code of FINDING_CODES) {
      const definition = FINDING_DEFINITIONS[code];
      for (const text of [definition.title, definition.explanation, definition.recommendation]) {
        expect(text.en.trim(), code).not.toBe('');
        expect(text.fr.trim(), code).not.toBe('');
        expect(text.fr, code).not.toBe(text.en);
      }
    }
  });
});

describe('metricRating', () => {
  it('rates at the thresholds: ≤ good is good, ≤ poor needs improvement, above is poor', () => {
    expect(metricRating('lcpMs', 2_500)).toBe('good');
    expect(metricRating('lcpMs', 2_501)).toBe('needs_improvement');
    expect(metricRating('lcpMs', 4_000)).toBe('needs_improvement');
    expect(metricRating('lcpMs', 4_001)).toBe('poor');
    expect(metricRating('cls', 0.1)).toBe('good');
    expect(metricRating('cls', 0.26)).toBe('poor');
  });
});
