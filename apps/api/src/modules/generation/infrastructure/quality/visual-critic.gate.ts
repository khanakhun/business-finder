import { type AiGateway, QualityVisualCritic, VISUAL_CRITERIA, type VisualCriticOutput } from '@bf/ai';
import type { QualityIssue } from '@bf/contracts';
import { parseSite } from '@bf/site-schema';
import type { AuditContext } from './audit-gates.ts';
import type { GateOutcome, QualityGate } from './gates.ts';

// The visual critic gate (BF-045, AI with vision): the audit's screenshots (home at desktop and mobile, the heaviest
// inner page at desktop) graded on the anchored rubric. It passes when the average reaches the threshold and no
// criterion falls below its floor (calibrated: docs/quality/visual-rubric.md); its issues name the outline's blocks
// and a repair strategy the engines know. The score is the average on 0–100.

const LABELS = { desktop: 'desktop 1280 px', mobile: 'mobile 390 px at 2×' } as const;

export function visualCriticGate(gateway: AiGateway): QualityGate {
  return {
    id: 'visual',
    async run(ctx): Promise<GateOutcome> {
      const parsed = parseSite(ctx.spec);
      if (!parsed.spec) return { status: 'skipped', costUsd: 0, issues: [] };
      const site = parsed.spec;
      const audit = await (ctx as AuditContext).audit();
      const shots = (audit.screenshots ?? []).filter((shot) => audit.images.has(shot.file));
      if (shots.length === 0) throw new Error('The audit returned no screenshots for the critic.');
      const outline = site.pages.map((page) => ({
        page: page.id,
        blocks: page.blocks.map((block) => ({ id: block.id, type: block.type, variant: block.variant })),
      }));
      const result = await gateway.vision(
        QualityVisualCritic,
        {
          input: {
            business: { name: site.brand.name.slice(0, 200), category: null },
            direction: {
              market: ctx.direction?.market ?? 'local',
              tone: ctx.direction?.tone ?? 'warm',
              style: String((site.theme as { style?: unknown }).style ?? 'default').slice(0, 40),
            },
            outline,
            screenshots: shots.map((shot) => `${shot.page}, ${LABELS[shot.viewport]}`),
          },
          images: shots.map((shot) => ({
            bytes: audit.images.get(shot.file) as Buffer,
            mediaType: 'image/png',
          })),
        },
        { orgId: ctx.organizationId ?? null },
      );
      const answer = result.output as VisualCriticOutput;
      const rubric = Object.fromEntries(
        VISUAL_CRITERIA.map((criterion) => [
          criterion,
          answer.criteria.find((c) => c.criterion === criterion)?.score ?? 1,
        ]),
      ) as Record<(typeof VISUAL_CRITERIA)[number], number>;
      const scores = Object.values(rubric);
      const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
      const { minAverage, minCriterion } = ctx.thresholds.visual;
      const failing = new Set(VISUAL_CRITERIA.filter((criterion) => rubric[criterion] < minCriterion));
      const passed = average >= minAverage && failing.size === 0;
      const blocks = new Map(
        outline.flatMap((page) => page.blocks.map((block) => [block.id, page.page] as const)),
      );
      const issues: QualityIssue[] = answer.issues.map((issue) => {
        const blockId = issue.blockId && blocks.get(issue.blockId) === issue.page ? issue.blockId : undefined;
        return {
          gate: 'visual',
          code: `visual.${issue.criterion}`,
          // Below the bar, every issue is worth a repair; above it, they are advice.
          severity: passed ? 'warning' : 'error',
          message: `${issue.message} (${issue.criterion} ${rubric[issue.criterion]}/5).`.slice(0, 600),
          target: { pageId: issue.page, ...(blockId ? { blockId } : {}) },
          repairable: true,
          autoFixable: false,
          suggestedFix: `${issue.fix}: ${issue.suggestion}`.slice(0, 400),
        };
      });
      if (!passed && issues.length === 0)
        issues.push({
          gate: 'visual',
          code: 'visual.below_bar',
          severity: 'error',
          message:
            `The design scores ${average.toFixed(1)}/5${failing.size ? `, with ${[...failing].join(', ')} below ${minCriterion}` : ''}: ${answer.summary}`.slice(
              0,
              600,
            ),
          repairable: true,
          autoFixable: false,
        });
      return {
        status: passed ? 'pass' : 'fail',
        score: Math.round(((average - 1) / 4) * 100),
        costUsd: result.costUsd ?? 0,
        issues,
        rubric,
        model: result.model.slice(0, 80),
        promptVersion: result.promptVersion,
      };
    },
  };
}
