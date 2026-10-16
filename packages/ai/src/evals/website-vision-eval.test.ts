import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../evals/website.vision_grade/eval.config.ts';
import { createFakeAiGateway } from '../testing/fake-gateway.ts';
import { runEval } from './run-eval.ts';
import type { EvalRow } from './scorers.ts';

// CI replays the vision eval on its synthetic fixture sites. The answers are SIMULATED (no model key when BF-030 was
// built): `pnpm eval --task website.vision_grade --record` replaces them with real ones.
describe('website.vision_grade eval (replay)', () => {
  const rows = readFileSync(
    new URL('../../evals/website.vision_grade/dataset.jsonl', import.meta.url),
    'utf8',
  )
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as EvalRow);

  it('covers good, average and poor synthetic sites with two screenshots each', () => {
    const bands = new Set(rows.map((row) => (row.expected as { band: string }).band));
    expect(bands).toEqual(new Set(['good', 'average', 'poor']));
    for (const row of rows) expect((row.input as { images: string[] }).images).toHaveLength(2);
  });

  it('passes its thresholds on the replayed answers', async () => {
    const gateway = createFakeAiGateway({
      fixturesDir: new URL('../../fixtures/', import.meta.url).pathname,
    });
    const report = await runEval(config, rows, { gateway, model: 'fixtures', mode: 'replay' });
    expect(report.rows.filter((r) => r.error)).toEqual([]);
    expect(report.failures).toEqual([]);
  });
});
