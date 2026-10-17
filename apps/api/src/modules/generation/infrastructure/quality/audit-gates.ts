import type { QualityIssue } from '@bf/contracts';
import type { AxeFinding, LighthouseFinding } from '@bf/sitekit';
import type { GateContext, GateOutcome, QualityGate } from './gates.ts';
import type { AuditRun } from './sandbox-audit.client.ts';

// The render-based gates (BF-045): accessibility from axe-core (every page × locale, mobile and desktop) and
// performance from Lighthouse (home and the heaviest inner page, both presets), both on one sandboxed audit. Each
// finding becomes a targeted issue, tagged by who can fix it: the content (an engine: contrast, headings, link text,
// heavy images) or the platform (renderer, fonts, CSS, scripts: no repair, an alert).

/** The audit of the candidate (the pipeline provides it, memoized per candidate). */
export type AuditContext = GateContext & { readonly audit: () => Promise<AuditRun> };

/** axe rules an engine fixes by editing the site (texts, headings, palette, alt text). */
const CONTENT_RULES = new Set([
  'color-contrast',
  'color-contrast-enhanced',
  'heading-order',
  'empty-heading',
  'page-has-heading-one',
  'link-name',
  'image-alt',
  'button-name',
  'document-title',
  'label',
  'link-in-text-block',
]);

/** The block an axe node sits in, from its section's DOM id (`b-<blockId>`). */
function blockOf(ctx: GateContext, pageId: string, domId: string | null): string | undefined {
  if (!domId?.startsWith('b-')) return undefined;
  const id = domId.slice(2);
  const site = ctx.spec as { pages?: { id: string; blocks?: { id: string }[] }[] };
  return site.pages?.find((page) => page.id === pageId)?.blocks?.some((block) => block.id === id)
    ? id
    : undefined;
}

function axeIssue(ctx: GateContext, finding: AxeFinding): QualityIssue {
  const severity =
    finding.impact === 'serious' || finding.impact === 'critical'
      ? 'error'
      : finding.impact === 'moderate'
        ? 'warning'
        : 'info';
  const content = CONTENT_RULES.has(finding.rule);
  const blockId = blockOf(ctx, finding.page, finding.nodes[0]?.blockDomId ?? null);
  return {
    gate: 'a11y',
    code: finding.rule,
    severity,
    message:
      `${finding.help} (${finding.page}, ${finding.locale}, ${finding.viewport}; ${finding.nodes.length} element(s)).`.slice(
        0,
        600,
      ),
    target: { pageId: finding.page, ...(blockId ? { blockId } : {}), locale: finding.locale },
    evidence: finding.nodes[0]?.html.slice(0, 600),
    repairable: content,
    autoFixable: false,
    ...(content ? {} : { platform: true }),
    suggestedFix: content
      ? 'Change the content of this block: contrast of its colours, heading levels, link and button texts, alt text.'
      : 'A renderer or layout problem: the team fixes it.',
  };
}

/** Accessibility: serious and critical violations fail; the score drops with each by impact. */
export const a11yGate: QualityGate = {
  id: 'a11y',
  async run(ctx): Promise<GateOutcome> {
    const report = await (ctx as AuditContext).audit();
    // One issue per rule, page and locale (the two viewports usually agree): the widest view of each problem.
    const seen = new Map<string, AxeFinding>();
    for (const finding of report.axe) {
      const key = `${finding.rule}|${finding.page}|${finding.locale}`;
      const known = seen.get(key);
      if (!known || finding.nodes.length > known.nodes.length) seen.set(key, finding);
    }
    const issues = [...seen.values()].map((finding) => axeIssue(ctx, finding));
    const weight = { critical: 25, serious: 10, moderate: 3, minor: 1 } as const;
    const penalty = [...seen.values()].reduce(
      (sum, finding) => sum + (finding.impact ? weight[finding.impact] : 0),
      0,
    );
    return {
      status: issues.some((issue) => issue.severity === 'error') ? 'fail' : 'pass',
      score: Math.max(0, 100 - penalty),
      costUsd: 0,
      issues: issues.slice(0, 200),
    };
  },
};

/** Lighthouse audits a site's content causes (an engine can change them); everything else is the platform's. */
const CONTENT_AUDITS = new Set([
  'image-delivery-insight',
  'uses-optimized-images',
  'uses-responsive-images',
  'modern-image-formats',
  'offscreen-images',
  'total-byte-weight',
  'dom-size',
  'dom-size-insight',
  'lcp-discovery-insight',
  'largest-contentful-paint-element',
  'meta-description',
  'document-title',
  'link-text',
  'image-alt',
  'color-contrast',
  'heading-order',
  'crawlable-anchors',
]);

const CATEGORIES = [
  ['performance', 'performance'],
  ['accessibility', 'accessibility'],
  ['bestPractices', 'best practices'],
  ['seo', 'SEO'],
] as const;

function lighthouseIssues(ctx: GateContext, finding: LighthouseFinding): QualityIssue[] {
  const issues: QualityIssue[] = [];
  for (const [key, label] of CATEGORIES) {
    const score = finding.scores[key];
    const min = ctx.thresholds.lighthouse[key];
    if (score === null || score >= min) continue;
    const content = finding.failing.filter((audit) => CONTENT_AUDITS.has(audit.id));
    const platform = content.length === 0;
    const named = (platform ? finding.failing : content)
      .slice(0, 4)
      .map((audit) => `${audit.title}${audit.displayValue ? ` (${audit.displayValue})` : ''}`);
    issues.push({
      gate: 'performance',
      code: `lighthouse.${key}`,
      severity: 'error',
      message:
        `Lighthouse ${label} ${score} < ${min} on ${finding.page} (${finding.preset})${named.length ? `: ${named.join('; ')}` : ''}.`.slice(
          0,
          600,
        ),
      target: { pageId: finding.page, locale: finding.locale },
      repairable: !platform,
      autoFixable: false,
      ...(platform ? { platform: true } : {}),
      suggestedFix: platform
        ? 'The renderer, fonts or scripts are the cause: the team fixes it (no repair).'
        : 'Lighter content on this page: fewer or smaller images, fewer sections, a lighter hero.',
    });
  }
  return issues;
}

/** Performance (and Lighthouse's other categories): below the thresholds fails; the score is the lowest performance. */
export const performanceGate: QualityGate = {
  id: 'performance',
  async run(ctx): Promise<GateOutcome> {
    const report = await (ctx as AuditContext).audit();
    const issues = report.lighthouse.flatMap((finding) => lighthouseIssues(ctx, finding));
    const scores = report.lighthouse
      .map((finding) => finding.scores.performance)
      .filter((s): s is number => s !== null);
    return {
      status: issues.length > 0 ? 'fail' : 'pass',
      ...(scores.length ? { score: Math.min(...scores) } : {}),
      costUsd: 0,
      issues,
    };
  },
};
