import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../evals/demo.extract_business_facts/eval.config.ts';
import { createFakeAiGateway } from '../testing/fake-gateway.ts';
import { runEval } from './run-eval.ts';
import type { EvalRow } from './scorers.ts';

// CI runs the demo eval against its recorded fixtures (no network); `pnpm eval` runs it on real models.
describe('demo.extract_business_facts eval (replay)', () => {
  it('passes its thresholds on the recorded answers', async () => {
    const rows = readFileSync(
      new URL('../../evals/demo.extract_business_facts/dataset.jsonl', import.meta.url),
      'utf8',
    )
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as EvalRow);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    const gateway = createFakeAiGateway({
      fixturesDir: new URL('../../fixtures/', import.meta.url).pathname,
    });
    const report = await runEval(config, rows, { gateway, model: 'fixtures', mode: 'replay' });
    expect(report.rows.filter((r) => r.error)).toEqual([]);
    expect(report.failures).toEqual([]);
  });
});
