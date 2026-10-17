import type { AiGateway, VisualCriticInput, VisualCriticOutput } from '@bf/ai';
import { VISUAL_CRITERIA } from '@bf/ai';
import type { AuditReport } from '@bf/sitekit';
import { describe, expect, it } from 'vitest';
import type { StoredJob } from '../../application/ports.ts';
import { evalWorkspace, loadBusinesses } from '../engines/blocks/eval/harness.ts';
import { FullQualityPipeline } from './full-quality.pipeline.ts';

// The visual critic (BF-045) with a scripted vision model on a real workspace, through the pipeline: the audit's
// screenshots and the outline go to the critic; a grade above the bar passes (issues become advice); a criterion
// below its floor is a targeted repair; the screenshots are stored with the report; no screenshot is never a pass.

const [business] = loadBusinesses();
if (!business) throw new Error('no eval business');
const workspace = evalWorkspace(business);
const job = { id: 'job-1', organizationId: 'org-1' } as StoredJob;
const hero = workspace.starter.pages[0]?.blocks.find((block) => block.type === 'hero');

const audit = (withShots = true): AuditReport & { images: Map<string, Buffer> } => ({
  axe: [],
  lighthouse: [],
  pages: workspace.starter.pages.map((page) => page.id),
  durationMs: 1,
  ...(withShots
    ? {
        screenshots: [
          { page: 'home', viewport: 'desktop' as const, file: '.sitekit/audit/home.desktop.png' },
          { page: 'home', viewport: 'mobile' as const, file: '.sitekit/audit/home.mobile.png' },
        ],
      }
    : {}),
  images: new Map(
    withShots
      ? [
          ['.sitekit/audit/home.desktop.png', Buffer.from('desktop-png')],
          ['.sitekit/audit/home.mobile.png', Buffer.from('mobile-png')],
        ]
      : [],
  ),
});

function critic(
  grades: Partial<Record<(typeof VISUAL_CRITERIA)[number], number>>,
  issues: VisualCriticOutput['issues'] = [],
) {
  const seen: { input: VisualCriticInput; images: number }[] = [];
  const gateway = {
    async vision(_task: unknown, request: { input: VisualCriticInput; images: unknown[] }) {
      seen.push({ input: request.input, images: request.images.length });
      return {
        output: {
          criteria: VISUAL_CRITERIA.map((criterion) => ({
            criterion,
            score: grades[criterion] ?? 4,
            evidence: 'x',
          })),
          issues,
          summary: 'A calm, readable site.',
        } satisfies VisualCriticOutput,
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        promptVersion: 1,
        usage: { inputTokens: 5000, outputTokens: 600, cachedTokens: 0 },
        costUsd: 0.03,
        cached: false,
        latencyMs: 1,
      };
    },
    async run() {
      return {
        output: { claims: [], warnings: [] },
        provider: 'anthropic',
        model: 'x',
        promptVersion: 1,
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        costUsd: 0,
        cached: false,
        latencyMs: 1,
      };
    },
  } as unknown as AiGateway;
  return { gateway, seen };
}

function pipeline(gateway: AiGateway, shots = true) {
  const stored = new Map<string, Buffer>();
  const p = new FullQualityPipeline({
    artifacts: {
      get: async () => Buffer.from(workspace.bundle),
      put: async (key, body) => {
        stored.set(key, body);
      },
    },
    repository: { artifactKey: async () => 'bundle' },
    assetHosts: ['assets.bf-sites.test'],
    gateway,
    audits: { audit: async () => audit(shots) },
  });
  return { p, stored };
}
const evaluate = (p: FullQualityPipeline) =>
  p.evaluate({ job, spec: workspace.starter, repairsLeft: 2, supportsRepair: true, attemptId: 'a1' });

describe('visual critic gate', () => {
  it('passes a site above the bar, keeping its issues as advice, its rubric and its screenshots', async () => {
    const { gateway, seen } = critic({}, [
      {
        criterion: 'imagery',
        page: 'home',
        blockId: hero?.id ?? null,
        message: 'The hero photo is dark.',
        fix: 'swap_hero_asset',
        suggestion: 'Use the terrace photo.',
      },
    ]);
    const { p, stored } = pipeline(gateway);
    const result = await evaluate(p);
    expect(result.outcome).toBe('pass');
    const gate = result.report?.gates.find((g) => g.id === 'visual');
    expect(gate).toMatchObject({
      status: 'pass',
      score: 75,
      costUsd: 0.03,
      model: 'claude-sonnet-5-5',
      rubric: { imagery: 4 },
    });
    expect(gate?.issues[0]).toMatchObject({
      severity: 'warning',
      target: { pageId: 'home', blockId: hero?.id },
      suggestedFix: 'swap_hero_asset: Use the terrace photo.',
    });
    // The critic saw both screenshots with the outline and the brief's direction.
    expect(seen[0]).toMatchObject({
      images: 2,
      input: { screenshots: ['home, desktop 1280 px', 'home, mobile 390 px at 2×'] },
    });
    expect(seen[0]?.input.outline[0]?.blocks.length).toBeGreaterThan(0);
    expect(result.report?.screenshots.map((shot) => shot.viewport)).toEqual(['desktop', 'mobile']);
    expect([...stored.keys()].every((key) => key.startsWith('generation/org-1/job-1/quality/'))).toBe(true);
  });

  it('sends a site with a criterion below its floor to a repair, targeted to the block', async () => {
    const { gateway } = critic({ imagery: 2 }, [
      {
        criterion: 'imagery',
        page: 'home',
        blockId: hero?.id ?? null,
        message: 'The hero has no photo.',
        fix: 'swap_hero_asset',
        suggestion: 'Use the salon photo.',
      },
      {
        criterion: 'cta',
        page: 'home',
        blockId: 'not-a-block',
        message: 'Two competing buttons.',
        fix: 'other',
        suggestion: 'Keep "Réserver".',
      },
    ]);
    const result = await evaluate(pipeline(gateway).p);
    expect(result.outcome).toBe('repair');
    const issues = result.report?.issues.filter((issue) => issue.gate === 'visual') ?? [];
    expect(issues.map((issue) => issue.severity)).toEqual(['error', 'error']);
    expect(issues.find((issue) => issue.code === 'visual.imagery')?.target).toEqual({
      pageId: 'home',
      blockId: hero?.id,
    });
    // A block id that is not in the outline is dropped (the page stays).
    expect(issues.find((issue) => issue.code === 'visual.cta')?.target).toEqual({ pageId: 'home' });
  });

  it('names the bar when the average fails without issues, and never passes without screenshots', async () => {
    const low = await evaluate(
      pipeline(
        critic({
          hierarchy: 3,
          typography: 3,
          spacing: 3,
          imagery: 3,
          color: 3,
          cta: 3,
          mobile: 3,
          brand_fit: 3,
          originality: 3,
        }).gateway,
      ).p,
    );
    expect(low.outcome).toBe('repair');
    expect(low.report?.issues.find((issue) => issue.gate === 'visual')).toMatchObject({
      code: 'visual.below_bar',
    });

    const blind = await evaluate(pipeline(critic({}).gateway, false).p);
    expect(blind).toMatchObject({ outcome: 'needs_review', report: { infraError: true } });
  });
});
