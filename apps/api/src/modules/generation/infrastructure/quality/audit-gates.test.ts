import type { AuditReport, AxeFinding, LighthouseFinding } from '@bf/sitekit';
import { describe, expect, it } from 'vitest';
import type { StoredJob } from '../../application/ports.ts';
import { evalWorkspace, loadBusinesses } from '../engines/blocks/eval/harness.ts';
import { FullQualityPipeline } from './full-quality.pipeline.ts';

// The render-based gates (BF-045) on scripted audit reports, through the pipeline on a real workspace: content
// problems are targeted repairs, platform problems go to a person without a repair loop, one audit serves both
// gates per candidate, and a failed audit is never a pass.

const [business] = loadBusinesses();
if (!business) throw new Error('no eval business');
const workspace = evalWorkspace(business);
const job = { id: 'job-1', organizationId: 'org-1' } as StoredJob;
const heroId = workspace.starter.pages[0]?.blocks.find((block) => block.type === 'hero')?.id ?? '';

const axe = (overrides: Partial<AxeFinding>): AxeFinding => ({
  page: 'home',
  locale: 'fr',
  viewport: 'mobile',
  rule: 'color-contrast',
  impact: 'serious',
  help: 'Elements must meet minimum color contrast ratio thresholds',
  nodes: [{ target: '.bf-hero h1', blockDomId: `b-${heroId}`, html: '<h1>…</h1>' }],
  ...overrides,
});
const lighthouse = (overrides: Partial<LighthouseFinding> = {}): LighthouseFinding => ({
  page: 'home',
  locale: 'fr',
  preset: 'mobile',
  scores: { performance: 98, accessibility: 100, bestPractices: 100, seo: 100 },
  failing: [],
  ...overrides,
});
const report = (overrides: Partial<AuditReport> = {}): AuditReport => ({
  axe: [],
  lighthouse: [lighthouse(), lighthouse({ preset: 'desktop' })],
  pages: ['home'],
  durationMs: 1000,
  ...overrides,
});

function pipeline(audit: () => Promise<AuditReport>) {
  let calls = 0;
  const p = new FullQualityPipeline({
    artifacts: { get: async () => Buffer.from(workspace.bundle) },
    repository: { artifactKey: async () => 'bundle' },
    assetHosts: ['assets.bf-sites.test'],
    audits: {
      audit: async (files, spec) => {
        calls++;
        expect(files.has('facts.json')).toBe(true);
        expect(spec).toBeDefined();
        return audit();
      },
    },
  });
  return { p, calls: () => calls };
}
const evaluate = (p: FullQualityPipeline, repairsLeft = 2) =>
  p.evaluate({ job, spec: workspace.starter, repairsLeft, supportsRepair: true, attemptId: 'a1' });

describe('accessibility and performance gates', () => {
  it('pass a clean audit, with both gates scored from one audit run', async () => {
    const { p, calls } = pipeline(async () => report());
    const result = await evaluate(p);
    expect(result.outcome).toBe('pass');
    const gates = Object.fromEntries((result.report?.gates ?? []).map((gate) => [gate.id, gate]));
    expect(gates.a11y).toMatchObject({ status: 'pass', score: 100 });
    expect(gates.performance).toMatchObject({ status: 'pass', score: 98 });
    // One audit, on the final candidate (after the auto-fixes), for both gates.
    expect(calls()).toBe(1);
  });

  it('makes a content violation a repair targeted to its block, and a layout one a platform problem', async () => {
    const content = await evaluate(
      pipeline(async () => report({ axe: [axe({}), axe({ viewport: 'desktop', nodes: [] })] })).p,
    );
    expect(content.outcome).toBe('repair');
    const [issue] = content.report?.issues ?? [];
    expect(issue).toMatchObject({
      gate: 'a11y',
      code: 'color-contrast',
      repairable: true,
      target: { pageId: 'home', blockId: heroId, locale: 'fr' },
    });
    // The two viewports' findings of one rule are one issue.
    expect(content.report?.issues.filter((i) => i.gate === 'a11y')).toHaveLength(1);

    const layout = await evaluate(
      pipeline(async () =>
        report({
          axe: [axe({ rule: 'region', nodes: [{ target: 'body > div', blockDomId: null, html: '' }] })],
        }),
      ).p,
    );
    expect(layout.outcome).toBe('needs_review');
    expect(layout.report?.issues[0]).toMatchObject({ code: 'region', platform: true, repairable: false });

    const minor = await evaluate(pipeline(async () => report({ axe: [axe({ impact: 'moderate' })] })).p);
    expect(minor.outcome).toBe('pass');
    expect(minor.report?.gates.find((gate) => gate.id === 'a11y')).toMatchObject({
      status: 'pass',
      score: 97,
    });
  });

  it('tags Lighthouse failures by cause: heavy images are the content’s, render-blocking CSS the platform’s', async () => {
    const heavy = await evaluate(
      pipeline(async () =>
        report({
          lighthouse: [
            lighthouse({
              scores: { performance: 71, accessibility: 100, bestPractices: 100, seo: 100 },
              failing: [
                {
                  id: 'image-delivery-insight',
                  title: 'Improve image delivery',
                  score: 0,
                  displayValue: 'Est savings of 1.2 MB',
                },
              ],
            }),
          ],
        }),
      ).p,
    );
    expect(heavy.outcome).toBe('repair');
    expect(heavy.report?.issues[0]).toMatchObject({
      code: 'lighthouse.performance',
      repairable: true,
      target: { pageId: 'home' },
    });
    expect(heavy.report?.issues[0]?.message).toMatch(/71 < 90.*Improve image delivery/);

    const platform = await evaluate(
      pipeline(async () =>
        report({
          lighthouse: [
            lighthouse({
              scores: { performance: 62, accessibility: 100, bestPractices: 100, seo: 100 },
              failing: [{ id: 'render-blocking-insight', title: 'Render blocking requests', score: 0 }],
            }),
          ],
        }),
      ).p,
    );
    expect(platform.outcome).toBe('needs_review');
    expect(platform.report?.issues[0]).toMatchObject({ platform: true, repairable: false });
  });

  it('never passes when the audit sandbox fails (tried twice)', async () => {
    const { p, calls } = pipeline(async () => {
      throw new Error('sitekit audit did not complete (timeout)');
    });
    const result = await evaluate(p);
    expect(result).toMatchObject({ outcome: 'needs_review', report: { infraError: true } });
    expect(result.report?.gates.find((gate) => gate.id === 'a11y')).toMatchObject({ status: 'error' });
    expect(calls()).toBe(2);
  });
});
