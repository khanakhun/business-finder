import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../evals/generation.extract_site_facts/eval.config.ts';
import { ExtractSiteFactsOutput } from '../tasks/generation-extract-site-facts.ts';
import { createFakeAiGateway } from '../testing/fake-gateway.ts';
import { runEval } from './run-eval.ts';
import type { EvalRow } from './scorers.ts';

// CI replays the site-fact extraction eval (no network). Its answers are SIMULATED, not recorded from a model: they
// list the pages' facts with verbatim quotes, miss a few, and include every seeded hallucination the way a careless
// model would write it. `pnpm eval --task generation.extract_site_facts --record` replaces them with real ones.
describe('generation.extract_site_facts eval (replay)', () => {
  const dir = new URL('../../evals/generation.extract_site_facts/', import.meta.url);
  const lines = (file: string) =>
    readFileSync(new URL(file, dir), 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { id: string });
  const rows = lines('dataset.jsonl') as EvalRow[];
  const replayed = lines('replay-outputs.jsonl') as { id: string; output: unknown }[];

  it('covers at least 55 businesses in French and English, with prompt-injection attempts', () => {
    expect(rows.length).toBeGreaterThanOrEqual(55);
    expect(rows.some((row) => row.tags?.includes('fr'))).toBe(true);
    expect(rows.some((row) => row.tags?.includes('en'))).toBe(true);
    expect(rows.filter((row) => row.tags?.includes('injection')).length).toBeGreaterThanOrEqual(4);
  });

  it('replays one well-formed answer per row', () => {
    expect(replayed.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    for (const { id, output } of replayed) {
      const parsed = ExtractSiteFactsOutput.safeParse(output);
      expect(parsed.success, `${id}: ${parsed.error?.message ?? ''}`).toBe(true);
    }
  });

  it('passes its thresholds on the replayed answers', async () => {
    const gateway = createFakeAiGateway({
      fixturesDir: new URL('../../fixtures/', import.meta.url).pathname,
    });
    const report = await runEval(config, rows, { gateway, model: 'fixtures', mode: 'replay' });
    expect(report.rows.filter((r) => r.error)).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.means['verified.precision']).toBeGreaterThanOrEqual(0.98);
    expect(report.means['hallucinations.rejected']).toBe(1);
    expect(report.means['recall.services_prices_hours']).toBeGreaterThanOrEqual(0.8);
    expect(report.means['warnings.injection']).toBe(1);
  });
});
