import { QualityReportSchema } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import type { StoredJob } from '../../application/ports.ts';
import { evalWorkspace, loadBusinesses } from '../engines/blocks/eval/harness.ts';
import { FullQualityPipeline } from './full-quality.pipeline.ts';
import type { QualityGate } from './gates.ts';
import { copyGate, factsGate, schemaGate } from './gates.ts';

// The quality pipeline (BF-045) on real workspaces (eval businesses: brief, registry, starter site): the starter
// passes; a seeded invented fact is a targeted repair; schema errors stop the chain; safe fixes are applied and the
// gates re-run on the fixed candidate; a missing registry or a broken gate never passes; results are cached.

const [business] = loadBusinesses();
if (!business) throw new Error('no eval business');
const workspace = evalWorkspace(business);
const job = { id: 'job-1', organizationId: 'org-1' } as StoredJob;

function pipeline(options: { gates?: QualityGate[]; bundle?: Uint8Array | null } = {}) {
  return new FullQualityPipeline({
    artifacts: {
      get: async () =>
        options.bundle === null ? undefined : Buffer.from(options.bundle ?? workspace.bundle),
    },
    repository: { artifactKey: async () => 'bundle-key' },
    assetHosts: ['assets.bf-sites.test'],
    ...(options.gates ? { gates: options.gates } : {}),
    now: () => new Date('2026-10-17T08:00:00.000Z'),
  });
}

type Site = {
  pages: { id: string; blocks: { id: string; type: string; props: Record<string, unknown> }[] }[];
};
const site = (change: (spec: Site) => void) => {
  const spec = structuredClone(workspace.starter) as unknown as Site;
  change(spec);
  return spec;
};
const hero = (spec: Site) => {
  const block = spec.pages[0]?.blocks.find((candidate) => candidate.type === 'hero');
  if (!block) throw new Error('no hero');
  return block;
};
const evaluate = (spec: unknown, p = pipeline(), repairsLeft = 2) =>
  p.evaluate({ job, spec, repairsLeft, supportsRepair: true, attemptId: 'attempt-1' });

describe('FullQualityPipeline', () => {
  it('passes the starter site, with a valid report and the gates in order', async () => {
    const result = await evaluate(workspace.starter);
    expect(result.outcome).toBe('pass');
    expect(QualityReportSchema.safeParse(result.report).success).toBe(true);
    // The deterministic gates pass; the starter's French typography is fixed on the way (an `autofix` stage).
    expect(result.report?.gates.slice(0, 3).map((gate) => [gate.id, gate.status])).toEqual([
      ['schema', 'pass'],
      ['facts', 'pass'],
      ['copy', 'pass'],
    ]);
    expect(result.report).toMatchObject({ decision: 'pass', infraError: false, pipelineVersion: 1 });
    expect(result.score).toBeGreaterThan(50);
  });

  it('sends an invented fact to a repair, targeted to its block and locale', async () => {
    const spec = site((s) => {
      hero(s).props.subtitle = Object.fromEntries(
        workspace.starter.locales.map((l) => [l, 'Ouvert depuis 1987, 4,9/5']),
      );
    });
    const result = await evaluate(spec);
    expect(result.outcome).toBe('repair');
    const issues = result.report?.issues ?? [];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.length).toBeLessThanOrEqual(12);
    expect(issues[0]).toMatchObject({
      repairable: true,
      target: { pageId: 'home', blockId: hero(spec).id, locale: expect.any(String) },
    });
    // What engines read: the issue with `at` (BF-041/BF-044).
    expect(result.issues[0]).toMatchObject({
      at: expect.stringMatching(/^pages\[0\]\.blocks\[\d+\]\.props\.subtitle/),
    });
    // Without repairs left, the same version goes to a person.
    expect((await evaluate(spec, pipeline(), 0)).outcome).toBe('needs_review');
  });

  it('stops after a schema error: facts and copy are skipped', async () => {
    const result = await evaluate({ schemaVersion: 1, pages: 'nope' });
    expect(result.outcome).toBe('repair');
    expect(result.report?.gates.map((gate) => [gate.id, gate.status])).toEqual([
      ['schema', 'fail'],
      ['facts', 'skipped'],
      ['copy', 'skipped'],
    ]);
    expect(result.score).toBeLessThanOrEqual(40);
  });

  it('applies safe fixes, re-runs the gates on the fixed candidate and returns it', async () => {
    const spec = site((s) => {
      const target = hero(s);
      const title = target.props.title as Record<string, string>;
      if (title.fr) title.fr = `${title.fr} : sur rendez-vous`;
    });
    const result = await evaluate(spec);
    expect(result.report?.autoFixes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: 'copy.fr_typography',
          after: expect.stringContaining('\u00a0: sur rendez-vous'),
        }),
      ]),
    );
    expect(result.report?.gates.map((gate) => gate.id)).toEqual(['schema', 'facts', 'copy', 'autofix']);
    expect(JSON.stringify(result.spec)).toContain('\\u00a0: sur rendez-vous'.replace('\\u00a0', ' '));
    expect(result.outcome).toBe('pass');
  });

  it('never passes without the job’s registry, nor when a gate breaks (tried twice)', async () => {
    const missing = await evaluate(workspace.starter, pipeline({ bundle: null }));
    expect(missing).toMatchObject({ outcome: 'needs_review', report: { infraError: true } });
    expect(missing.report?.gates.find((gate) => gate.id === 'facts')).toMatchObject({ status: 'error' });

    let calls = 0;
    const broken: QualityGate = {
      id: 'copy',
      run: () => {
        calls++;
        throw new Error('renderer crashed');
      },
    };
    const result = await evaluate(workspace.starter, pipeline({ gates: [schemaGate, factsGate, broken] }));
    expect(calls).toBe(2);
    expect(result).toMatchObject({ outcome: 'needs_review', report: { infraError: true } });
    expect(result.report?.issues[0]).toMatchObject({ code: 'gate_error', repairable: false });
  });

  it('caches the gates’ results per candidate, and decides again with the repairs left', async () => {
    let calls = 0;
    const counting: QualityGate = {
      id: 'copy',
      run: (ctx) => {
        calls++;
        return copyGate.run(ctx);
      },
    };
    const p = pipeline({ gates: [schemaGate, factsGate, counting] });
    const spec = site((s) => {
      hero(s).props.subtitle = Object.fromEntries(
        workspace.starter.locales.map((l) => [l, 'Le meilleur salon']),
      );
    });
    expect((await evaluate(spec, p, 2)).outcome).toBe('repair');
    const first = calls;
    expect((await evaluate(spec, p, 0)).outcome).toBe('needs_review');
    expect(calls).toBe(first);
  });

  it('nudges a palette colour with too little contrast to the validator’s suggestion, then passes', async () => {
    const spec = structuredClone(workspace.starter) as unknown as {
      theme: { palette: Record<string, string> };
    };
    spec.theme.palette.text = '#d8d8d8';
    const result = await evaluate(spec);
    expect(result.report?.autoFixes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'contrast_low', path: 'theme.palette.text', before: '#d8d8d8' }),
      ]),
    );
    const fixed = result.spec as { theme: { palette: Record<string, string> } };
    expect(fixed.theme.palette.text).not.toBe('#d8d8d8');
    expect(result.outcome).toBe('pass');
  });
});
