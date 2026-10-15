import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../evals/search.parse_intent/eval.config.ts';
import { createFakeAiGateway } from '../testing/fake-gateway.ts';
import { runEval } from './run-eval.ts';
import type { EvalRow } from './scorers.ts';

// CI replays the search intent eval on its recorded fixtures (no network); `pnpm eval` runs it on real models.
describe('search.parse_intent eval (replay)', () => {
  it('passes its thresholds on the recorded answers', async () => {
    const rows = readFileSync(
      new URL('../../evals/search.parse_intent/dataset.jsonl', import.meta.url),
      'utf8',
    )
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as EvalRow);
    expect(rows.length).toBeGreaterThanOrEqual(80);
    const gateway = createFakeAiGateway({
      fixturesDir: new URL('../../fixtures/', import.meta.url).pathname,
    });
    const report = await runEval(config, rows, { gateway, model: 'fixtures', mode: 'replay' });
    expect(report.rows.filter((r) => r.error)).toEqual([]);
    expect(report.failures).toEqual([]);
  });
});

describe('search.parse_intent scorers', () => {
  it('judges clarification precision on asked rows and recall on rows that deserved a question', async () => {
    const scorer = (name: string) => config.scorers.find((s) => s.name === name);
    const context = { gateway: createFakeAiGateway({ fixturesDir: '/nonexistent' }), orgId: null };
    const row = (clarify: boolean) => ({ id: 'r', input: {}, expected: { clarify } }) as EvalRow;
    const asked = { needsClarification: { question: 'Which?' } };
    const silent = { needsClarification: null };
    const precision = scorer('needsClarification.precision');
    const recall = scorer('needsClarification.recall');
    expect(await precision?.score(asked, row(false), context)).toBe(0);
    expect(await precision?.score(silent, row(true), context)).toBeNull();
    expect(await recall?.score(silent, row(true), context)).toBe(0);
    expect(await recall?.score(asked, row(true), context)).toBe(1);
    expect(await recall?.score(asked, row(false), context)).toBeNull();
  });

  it('compares only the active filters, order-insensitively', async () => {
    const { activeFilters } = await import('../../evals/search.parse_intent/eval.config.ts');
    expect(
      activeFilters({ website: 'any', minRating: null, tags: [], tiers: ['B', 'A'], hasEmail: false }),
    ).toEqual({
      tiers: ['A', 'B'],
      hasEmail: false,
    });
  });
});
