import type { QualityGateId, QualityGateResult, QualityIssue } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { decide } from './decision-policy.ts';
import { MAX_REPAIR_ISSUES, prioritize } from './issue-prioritizer.ts';
import { HARD_GATE_CAP, qualityScore } from './scorer.ts';
import { PLATFORM_MINIMUMS, tighten } from './thresholds.ts';

// The quality pipeline's rules (BF-045): the decision matrix, the score, which issues a repair gets, and thresholds
// that can only be tightened.

const issue = (gate: QualityGateId, overrides: Partial<QualityIssue> = {}): QualityIssue => ({
  gate,
  code: `${gate}.x`,
  severity: 'error',
  message: 'Fix it.',
  repairable: true,
  autoFixable: false,
  ...overrides,
});
const gate = (id: QualityGateId, overrides: Partial<QualityGateResult> = {}): QualityGateResult => ({
  id,
  status: 'pass',
  durationMs: 1,
  costUsd: 0,
  issues: [],
  ...overrides,
});

describe('decision policy', () => {
  const failing = [gate('schema'), gate('copy', { status: 'fail', issues: [issue('copy')] })];

  it('passes when no gate has an error (warnings do not block)', () => {
    expect(
      decide({
        gates: [gate('schema'), gate('copy', { issues: [issue('copy', { severity: 'warning' })] })],
        repairsLeft: 2,
        supportsRepair: true,
      }),
    ).toMatchObject({ decision: 'pass', issues: [], infraError: false });
  });

  it('repairs repairable errors while repairs are left and the engine can repair', () => {
    expect(decide({ gates: failing, repairsLeft: 2, supportsRepair: true })).toMatchObject({
      decision: 'repair',
      issues: [expect.objectContaining({ gate: 'copy' })],
    });
    expect(decide({ gates: failing, repairsLeft: 0, supportsRepair: true }).decision).toBe('needs_review');
    expect(decide({ gates: failing, repairsLeft: 2, supportsRepair: false }).decision).toBe('needs_review');
  });

  it('sends unrepairable and platform errors to a person, never into a repair loop', () => {
    for (const stuck of [issue('a11y', { repairable: false }), issue('performance', { platform: true })]) {
      const result = decide({
        gates: [gate('copy', { status: 'fail', issues: [issue('copy'), stuck] })],
        repairsLeft: 2,
        supportsRepair: true,
      });
      expect(result.decision).toBe('needs_review');
      expect(result.issues).toHaveLength(2);
    }
  });

  it('never passes when a gate could not run', () => {
    const result = decide({
      gates: [gate('schema'), gate('a11y', { status: 'error' })],
      repairsLeft: 2,
      supportsRepair: true,
    });
    expect(result).toMatchObject({ decision: 'needs_review', infraError: true });
    expect(result.reason).toMatch(/a11y/);
  });
});

describe('score', () => {
  it('weighs copy, accessibility, performance and the rubric over what ran', () => {
    expect(qualityScore([gate('copy', { score: 80 })])).toBe(80);
    expect(
      qualityScore([
        gate('copy', { score: 100 }),
        gate('a11y', { score: 80 }),
        gate('performance', { score: 60 }),
        gate('visual', { score: 50 }),
      ]),
    ).toBe(Math.round(0.2 * 100 + 0.25 * 80 + 0.25 * 60 + 0.3 * 50));
    // A skipped or broken gate does not count; nothing scored is 100.
    expect(qualityScore([gate('copy', { score: 70 }), gate('a11y', { status: 'error', score: 0 })])).toBe(70);
    expect(qualityScore([gate('schema')])).toBe(100);
  });

  it('caps a version that fails a hard gate', () => {
    expect(qualityScore([gate('facts', { status: 'fail' }), gate('copy', { score: 100 })])).toBe(
      HARD_GATE_CAP,
    );
    expect(qualityScore([gate('claims', { status: 'fail' }), gate('copy', { score: 20 })])).toBe(20);
  });
});

describe('issue prioritizer', () => {
  it('orders by gate, then severity, then block, and caps the list', () => {
    const issues = [
      issue('visual', { target: { blockId: 'b' } }),
      issue('copy', { severity: 'warning' }),
      issue('facts', { target: { blockId: 'z' } }),
      issue('copy'),
      issue('facts', { target: { blockId: 'a' } }),
    ];
    expect(prioritize(issues).map((i) => `${i.gate}:${i.severity}:${i.target?.blockId ?? ''}`)).toEqual([
      'facts:error:a',
      'facts:error:z',
      'copy:error:',
      'copy:warning:',
      'visual:error:b',
    ]);
    expect(prioritize(Array.from({ length: 30 }, () => issue('copy')))).toHaveLength(MAX_REPAIR_ISSUES);
  });
});

describe('thresholds', () => {
  it('applies a workspace override only when it is stricter', () => {
    const tightened = tighten(PLATFORM_MINIMUMS, {
      lighthouse: { performance: 95, seo: 50 },
      visual: { minAverage: 4.2, minCriterion: 1 },
    });
    expect(tightened.lighthouse).toEqual({ ...PLATFORM_MINIMUMS.lighthouse, performance: 95 });
    expect(tightened.visual).toEqual({
      minAverage: 4.2,
      minCriterion: PLATFORM_MINIMUMS.visual.minCriterion,
    });
    expect(tighten(PLATFORM_MINIMUMS, { visual: { minAverage: 9 } })).toMatchObject({
      visual: { minAverage: 5 },
    });
    expect(tighten(PLATFORM_MINIMUMS)).toEqual(PLATFORM_MINIMUMS);
  });
});
