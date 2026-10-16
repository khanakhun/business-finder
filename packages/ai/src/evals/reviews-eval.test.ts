import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../evals/reviews.extract_pain_signals/eval.config.ts';
import { createFakeAiGateway } from '../testing/fake-gateway.ts';
import { runEval } from './run-eval.ts';
import type { EvalRow } from './scorers.ts';

// CI replays the review-mining eval (no network). Its answers are SIMULATED, not recorded from a model (no keys when
// BF-029 was built): `pnpm eval --task reviews.extract_pain_signals --record` replaces them with real ones.
describe('reviews.extract_pain_signals eval (replay)', () => {
  const rows = readFileSync(
    new URL('../../evals/reviews.extract_pain_signals/dataset.jsonl', import.meta.url),
    'utf8',
  )
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as EvalRow);

  it('covers at least 120 reviews in English and French, with injection attempts', () => {
    const reviews = rows.flatMap((row) => (row.input as { reviews: unknown[] }).reviews);
    expect(reviews.length).toBeGreaterThanOrEqual(120);
    expect(rows.some((row) => row.tags?.includes('fr'))).toBe(true);
    expect(rows.some((row) => row.tags?.includes('en'))).toBe(true);
    expect(rows.filter((row) => (row.expected as { injection: boolean }).injection).length).toBeGreaterThan(
      0,
    );
  });

  it('passes its thresholds on the replayed answers', async () => {
    const gateway = createFakeAiGateway({
      fixturesDir: new URL('../../fixtures/', import.meta.url).pathname,
    });
    const report = await runEval(config, rows, { gateway, model: 'fixtures', mode: 'replay' });
    expect(report.rows.filter((r) => r.error)).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.means['tags.macro_f1']).toBeGreaterThanOrEqual(0.8);
    expect(report.means['sentiment.mae']).toBeLessThanOrEqual(0.25);
  });
});
