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

/** A metric in [0, 1] for one row (Strategy). `name` keys thresholds, e.g. `phones.f1`. */
export interface Scorer {
  readonly name: string;
  score(output: unknown, row: EvalRow, context: ScoreContext): Promise<number> | number;
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
