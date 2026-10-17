import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../evals/quality.unsupported_claims/eval.config.ts';
import { UnsupportedClaimsOutput } from '../tasks/quality-unsupported-claims.ts';
import { createFakeAiGateway } from '../testing/fake-gateway.ts';
import { runEval } from './run-eval.ts';
import type { EvalRow } from './scorers.ts';

// CI replays the claims gate's eval (BF-045, no network). Its answers are SIMULATED, not recorded from a model: they
// catch the seeded unsupported claims but three, flag two generic phrases, and report the injections.
// `pnpm eval --task quality.unsupported_claims --record` replaces them with real ones.
describe('quality.unsupported_claims eval (replay)', () => {
  const dir = new URL('../../evals/quality.unsupported_claims/', import.meta.url);
  const lines = (file: string) =>
    readFileSync(new URL(file, dir), 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { id: string });
  const rows = lines('dataset.jsonl') as EvalRow[];
  const replayed = lines('replay-outputs.jsonl') as { id: string; output: unknown }[];

  it('covers at least 60 sites in French and English, clean ones and prompt injections', () => {
    expect(rows.length).toBeGreaterThanOrEqual(60);
    for (const tag of ['fr', 'en', 'clean', 'seeded'])
      expect(
        rows.some((row) => row.tags?.includes(tag)),
        tag,
      ).toBe(true);
    expect(rows.filter((row) => row.tags?.includes('injection')).length).toBeGreaterThanOrEqual(4);
  });

  it('replays one well-formed answer per row', () => {
    expect(replayed.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    for (const { id, output } of replayed) {
      const parsed = UnsupportedClaimsOutput.safeParse(output);
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
    expect(report.means['unsupported.recall']).toBeGreaterThanOrEqual(0.95);
    expect(report.means['generic.false_positive_rate']).toBeLessThanOrEqual(0.05);
  }, 30_000);
});
