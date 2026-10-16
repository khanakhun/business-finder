import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../evals/taxonomy.classify_business/eval.config.ts';
import { createFakeAiGateway } from '../testing/fake-gateway.ts';
import { runEval } from './run-eval.ts';
import type { EvalRow } from './scorers.ts';

// CI replays the taxonomy eval on its recorded fixtures (no network); `pnpm eval` runs it on real models.
describe('taxonomy.classify_business eval (replay)', () => {
  it('passes its thresholds on the recorded answers', async () => {
    const rows = readFileSync(
      new URL('../../evals/taxonomy.classify_business/dataset.jsonl', import.meta.url),
      'utf8',
    )
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as EvalRow);
    expect(rows.length).toBeGreaterThanOrEqual(60);
    const gateway = createFakeAiGateway({
      fixturesDir: new URL('../../fixtures/', import.meta.url).pathname,
    });
    const report = await runEval(config, rows, { gateway, model: 'fixtures', mode: 'replay' });
    expect(report.rows.filter((r) => r.error)).toEqual([]);
    expect(report.failures).toEqual([]);
  });
});
