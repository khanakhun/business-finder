import { z } from 'zod';
import type { AiGateway } from '../gateway.ts';
import { EvalJudge } from './judge-task.ts';

/** One eval row (`dataset.jsonl`): fake or anonymized data only. */
export interface EvalRow {
  readonly id: string;
  readonly input: unknown;
  readonly expected: unknown;
  readonly tags?: readonly string[];
}

export interface ScoreContext {
  readonly gateway: AiGateway;
  readonly orgId: string | null;
}

/**
 * A metric in [0, 1] for one row (Strategy). `name` keys thresholds, e.g. `phones.f1`. `null` means the metric does
 * not apply to the row (e.g. precision on rows that predicted nothing): it is left out of that scorer's mean.
 */
export interface Scorer {
  readonly name: string;
  score(output: unknown, row: EvalRow, context: ScoreContext): Promise<number | null> | number | null;
}

/** A dataset-level metric: sees every row and its output at once (`output` is undefined for a failed row). */
export interface AggregateScorer {
  readonly name: string;
  score(results: ReadonlyArray<{ readonly row: EvalRow; readonly output: unknown }>): number;
}

/** Value at a dotted path (`a.b.0.c`); undefined when absent. */
export function atPath(value: unknown, path: string): unknown {
  if (path === '') return value;
  return path.split('.').reduce<unknown>((current, key) => {
    if (current === null || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

const normalize = (value: unknown) =>
  typeof value === 'string'
    ? value.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ')
    : JSON.stringify(value);

/** 1 when the values at `path` are equal (strings compared case- and whitespace-insensitively). */
export const exactMatch = (path: string): Scorer => ({
  name: `${path || 'output'}.exact`,
  score: (output, row) => (normalize(atPath(output, path)) === normalize(atPath(row.expected, path)) ? 1 : 0),
});

/** F1 between the sets at `path` (both empty → 1). */
export const setF1 = (
  path: string,
  keyOf: (item: unknown) => string = (item) => normalize(item),
): Scorer => ({
  name: `${path}.f1`,
  score: (output, row) => {
    const predicted = new Set(((atPath(output, path) as unknown[] | undefined) ?? []).map(keyOf));
    const expected = new Set(((atPath(row.expected, path) as unknown[] | undefined) ?? []).map(keyOf));
    if (predicted.size === 0 && expected.size === 0) return 1;
    const hits = [...predicted].filter((item) => expected.has(item)).length;
    if (hits === 0) return 0;
    const precision = hits / predicted.size;
    const recall = hits / expected.size;
    return (2 * precision * recall) / (precision + recall);
  },
});

/** 1 when the number at `path` is within `tolerance` of the expected one. */
export const numericTolerance = (path: string, tolerance: number): Scorer => ({
  name: `${path}.within_${tolerance}`,
  score: (output, row) => {
    const actual = Number(atPath(output, path));
    const expected = Number(atPath(row.expected, path));
    return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance
      ? 1
      : 0;
  },
});

/** 1 when `predicate(value at path)` holds, e.g. "warnings is not empty" for injection rows. */
export const jsonPathMatch = (
  path: string,
  predicate: (value: unknown, row: EvalRow) => boolean,
  label = 'match',
): Scorer => ({
  name: `${path}.${label}`,
  score: (output, row) => (predicate(atPath(output, path), row) ? 1 : 0),
});

const JudgeVerdict = z.object({ score: z.number().min(0).max(1), reason: z.string() });

/**
 * LLM-as-judge with a rubric (ai-engineering.md §9): use sparingly, prefer a different model family than the task's,
 * and calibrate against human labels each release.
 */
export const llmJudge = (name: string, rubric: string): Scorer => ({
  name: `${name}.judge`,
  async score(output, row, context) {
    const verdict = await context.gateway.run(
      EvalJudge,
      {
        rubric,
        input: JSON.stringify(row.input),
        expected: JSON.stringify(row.expected),
        output: JSON.stringify(output),
      },
      { orgId: context.orgId },
    );
    return JudgeVerdict.parse(verdict.output).score;
  },
});

type AggregateResult = Parameters<AggregateScorer['score']>[0][number];

/**
 * Macro-F1 over `labels`: F1 of each label across every item of every row, averaged. A label nobody expected or
 * predicted is left out (no evidence either way); none left scores 1.
 */
export const macroF1 = (
  name: string,
  items: (result: AggregateResult) => ReadonlyArray<{
    readonly expected: readonly string[];
    readonly predicted: readonly string[];
  }>,
  labels: readonly string[],
): AggregateScorer => ({
  name,
  score(results) {
    const counts = new Map(labels.map((label) => [label, { tp: 0, fp: 0, fn: 0 }]));
    for (const item of results.flatMap(items)) {
      const expected = new Set(item.expected);
      const predicted = new Set(item.predicted);
      for (const [label, count] of counts) {
        if (expected.has(label) && predicted.has(label)) count.tp++;
        else if (predicted.has(label)) count.fp++;
        else if (expected.has(label)) count.fn++;
      }
    }
    const f1s = [...counts.values()]
      .filter((c) => c.tp + c.fp + c.fn > 0)
      .map((c) => (2 * c.tp) / (2 * c.tp + c.fp + c.fn));
    return f1s.length === 0 ? 1 : f1s.reduce((sum, f1) => sum + f1, 0) / f1s.length;
  },
});

/** Mean absolute error between paired numbers; a missing prediction counts as `missingError`. */
export const meanAbsoluteError = (
  name: string,
  pairs: (
    result: AggregateResult,
  ) => ReadonlyArray<{ readonly expected: number; readonly predicted: number | undefined }>,
  missingError: number,
): AggregateScorer => ({
  name,
  score(results) {
    const errors = results
      .flatMap(pairs)
      .map(({ expected, predicted }) =>
        predicted === undefined || !Number.isFinite(predicted)
          ? missingError
          : Math.abs(predicted - expected),
      );
    return errors.length === 0 ? 0 : errors.reduce((sum, e) => sum + e, 0) / errors.length;
  },
});
