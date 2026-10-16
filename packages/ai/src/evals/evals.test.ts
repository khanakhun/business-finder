import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ZERO_USAGE } from '../cost.ts';
import { defineTask } from '../define-task.ts';
import type { AiGateway } from '../gateway.ts';
import { defineEval } from './define-eval.ts';
import { reportMarkdown, runEval } from './run-eval.ts';
import {
  atPath,
  type EvalRow,
  exactMatch,
  jsonPathMatch,
  llmJudge,
  numericTolerance,
  setF1,
} from './scorers.ts';

const row = (expected: unknown, input: unknown = {}): EvalRow => ({ id: 'r', input, expected });

describe('scorers', () => {
  it('compare paths, sets and numbers', () => {
    expect(atPath({ a: [{ b: 2 }] }, 'a.0.b')).toBe(2);
    expect(atPath({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(exactMatch('h').score({ h: ' Lun–Ven  9h ' }, row({ h: 'lun–ven 9h' }), {} as never)).toBe(1);
    expect(exactMatch('h').score({ h: null }, row({ h: 'x' }), {} as never)).toBe(0);
    const f1 = setF1('xs');
    expect(f1.score({ xs: ['a', 'b'] }, row({ xs: ['b', 'c'] }), {} as never)).toBeCloseTo(0.5);
    expect(f1.score({ xs: [] }, row({ xs: [] }), {} as never)).toBe(1);
    expect(f1.score({ xs: ['z'] }, row({ xs: ['a'] }), {} as never)).toBe(0);
    expect(numericTolerance('n', 0.1).score({ n: 0.95 }, row({ n: 1 }), {} as never)).toBe(1);
    expect(numericTolerance('n', 0.1).score({ n: 'x' }, row({ n: 1 }), {} as never)).toBe(0);
    expect(
      jsonPathMatch('w', (v) => Array.isArray(v) && v.length > 0).score({ w: ['!'] }, row({}), {} as never),
    ).toBe(1);
  });

  it('asks a judge model for rubric scores', async () => {
    const gateway = {
      run: async () => ({
        output: { score: 0.75, reason: 'ok' },
        provider: 'anthropic',
        model: 'm',
        promptVersion: 1,
        usage: ZERO_USAGE,
        costUsd: 0,
        cached: false,
        latencyMs: 0,
      }),
    } as unknown as AiGateway;
    expect(await llmJudge('tone', 'Polite?').score('Hello', row('Hi'), { gateway, orgId: null })).toBe(0.75);
  });
});

describe('eval runner', () => {
  const Task = defineTask({
    name: 'evaltest.echo',
    kind: 'object',
    tier: 'fast',
    prompt: 'evaltest.echo.v1',
    input: z.object({ n: z.number() }),
    output: z.object({ n: z.number() }),
    maxOutputTokens: 10,
    timeoutMs: 100,
  });
  const gateway = {
    run: async (_task: unknown, input: { n: number }) => {
      if (input.n < 0) throw new Error('boom');
      return {
        output: { n: input.n === 2 ? 99 : input.n },
        provider: 'anthropic',
        model: 'm',
        promptVersion: 1,
        usage: ZERO_USAGE,
        costUsd: 0.001,
        cached: false,
        latencyMs: 1,
      };
    },
  } as unknown as AiGateway;
  const config = defineEval({ task: Task, scorers: [exactMatch('n')], thresholds: { 'n.exact': 0.5 } });
  const rows = [1, 2, 3, -1].map((n) => ({ id: `row-${n}`, input: { n }, expected: { n }, tags: ['t'] }));

  it('scores every row, counts failures as 0 and compares with thresholds', async () => {
    const report = await runEval(config, rows, {
      gateway,
      model: 'm',
      mode: 'test',
      concurrency: 2,
      now: () => new Date('2026-10-15T00:00:00Z'),
    });
    expect(report.means['n.exact']).toBe(0.5);
    expect(report.passed).toBe(true);
    expect(report.rows.find((r) => r.id === 'row--1')?.error).toBe('boom');
    expect(report.totalCostUsd).toBeCloseTo(0.003);
    const markdown = reportMarkdown(report);
    expect(markdown).toContain('**PASS**');
    expect(markdown).toContain('| row-2 | t | n.exact=0.00 |');

    const strict = defineEval({ ...config, thresholds: { 'n.exact': 0.9 } });
    const failing = await runEval(strict, rows, { gateway, model: 'm', mode: 'test' });
    expect(failing.passed).toBe(false);
    expect(failing.failures).toEqual(['n.exact: 0.500 < 0.9']);
  });

  it('rejects thresholds for unknown scorers', () => {
    expect(() => defineEval({ ...config, thresholds: { 'nope.f1': 1 } })).toThrow(/unknown scorer/);
  });
});
