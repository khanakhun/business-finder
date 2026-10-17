import { EngineEventSchema } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import {
  evalWorkspace,
  loadBusinesses,
  measure,
  type RowReport,
  rowReport,
  runEngine,
  summarize,
  thresholdFailures,
} from './harness.ts';
import { simulatedGateway } from './simulated-model.ts';

// The blocks engine's eval in CI (BF-041): every synthetic business through the real engine with the SIMULATED model
// (no network). It checks the pipeline — the plan checks, copy application, the self-check loop, the fallbacks —
// against the ticket's automatic thresholds; quality (the judge), cost and duration need real models
// (`pnpm --filter @bf/api eval:blocks`).

const businesses = loadBusinesses();

describe('blocks engine eval (simulated model)', () => {
  it('covers at least 24 businesses: FR/EN and EN-only, rich and sparse, prompt injections', () => {
    expect(businesses.length).toBeGreaterThanOrEqual(24);
    const tagged = (tag: string) => businesses.filter((business) => business.tags.includes(tag)).length;
    expect(businesses.filter((business) => business.siteLanguages.length === 2).length).toBeGreaterThan(0);
    expect(businesses.filter((business) => business.siteLanguages.length === 1).length).toBeGreaterThan(0);
    expect(tagged('rich')).toBeGreaterThan(0);
    expect(tagged('sparse')).toBeGreaterThan(0);
    expect(tagged('injection')).toBeGreaterThanOrEqual(2);
    expect(new Set(businesses.map((business) => business.id)).size).toBe(businesses.length);
  });

  it('every starter site is valid before the engine runs (the fallback holds)', () => {
    for (const business of businesses) {
      const workspace = evalWorkspace(business);
      const measured = measure(workspace.starter, workspace.facts);
      expect(measured.valid, business.id).toBe(true);
      // A starter text drawn from an injected fact may fail copy lint: the engine rewrites it.
      if (!business.tags.includes('injection'))
        expect(measured, business.id).toMatchObject({ factViolations: 0, lintErrors: 0 });
    }
  });

  it('meets the automatic thresholds on every business, with well-formed events in order', async () => {
    const rows: RowReport[] = [];
    for (const business of businesses) {
      const workspace = evalWorkspace(business);
      const run = await runEngine(workspace, simulatedGateway());
      for (const event of run.events)
        expect(EngineEventSchema.safeParse(event).success, business.id).toBe(true);
      expect(run.events[0]).toEqual({ type: 'status', phase: 'running' });
      const types = run.events.map((event) => event.type);
      expect(types.slice(-2), business.id).toEqual(['progress', 'done']);
      expect(types.indexOf('artifact')).toBeLessThan(types.indexOf('done'));
      rows.push(rowReport(business, workspace, run));
    }
    const summary = summarize(rows);
    expect(thresholdFailures(summary, { warnings: false })).toEqual([]);
    expect(summary.validRate).toBe(1);
    // The businesses whose facts hold an instruction: followed on the first ask, fixed when asked again.
    const injected = rows.filter((row) => row.tags.includes('injection'));
    expect(injected.every((row) => row.reasked > 0)).toBe(true);
    // Sparse businesses get shorter sites than rich ones.
    const pages = (tag: string) => {
      const tagged = rows.filter((row) => row.tags.includes(tag));
      return tagged.reduce((sum, row) => sum + row.pages, 0) / tagged.length;
    };
    expect(pages('sparse')).toBeLessThanOrEqual(pages('rich'));
  }, 60_000);

  it('stops within 3 s of an abort while a page is being written', async () => {
    const [business] = businesses;
    if (!business) throw new Error('no business');
    const workspace = evalWorkspace(business);
    const controller = new AbortController();
    const slow = simulatedGateway();
    const gateway = {
      run: async (task: { name: string }, input: unknown, context: { signal?: AbortSignal }) => {
        if (task.name === 'generation.site_copy') {
          setTimeout(() => controller.abort(), 10);
          await new Promise((_, reject) =>
            context.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
          );
        }
        return slow.run(task as never, input as never, context as never);
      },
    } as unknown as Parameters<typeof runEngine>[1];
    const started = performance.now();
    await expect(runEngine(workspace, gateway, { signal: controller.signal })).rejects.toThrow(/aborted/);
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
