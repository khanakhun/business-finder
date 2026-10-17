import type { QualityAutoFix, QualityGateId, QualityGateResult, QualityIssue } from '@bf/contracts';
import {
  type FactRegistry,
  type Issue,
  LIMITS,
  parseSite,
  type SiteSpec,
  validateFacts,
  validateSite,
} from '@bf/site-schema';
import { type LintIssue, lintCopy, pathString, type SitekitConfig } from '@bf/sitekit';
import { copyPaths } from '../../domain/blocks/compose.ts';
import type { QualityThresholds } from '../../domain/quality/thresholds.ts';

// The deterministic gates (BF-045, Chain of Responsibility, cheapest first): schema and semantics, facts against the
// job's registry (never auto-fixed: facts come from the registry), copy lint, and the auto-fixer that applies the
// safe fixes on the texts an engine writes. Each turns its findings into targeted quality issues.

export interface GateContext {
  readonly spec: unknown;
  readonly facts: FactRegistry;
  readonly config: SitekitConfig;
  readonly assetHosts: readonly string[];
  readonly hotlinkHosts: readonly string[];
  readonly thresholds: QualityThresholds;
  /** The job's workspace (AI gates bill their calls to it). */
  readonly organizationId?: string;
  /** The brief's design direction (the visual critic grades against it). */
  readonly direction?: { readonly market: string; readonly tone: string };
}

export type GateOutcome = Omit<QualityGateResult, 'id' | 'durationMs'>;

export interface QualityGate {
  readonly id: QualityGateId;
  run(ctx: GateContext): Promise<GateOutcome> | GateOutcome;
}

const FACT_CODES = new Set(['fact_unknown', 'fact_kind', 'fact_mismatch', 'unsupported_literal']);
const LOCALE = /^[a-z]{2}$/;

/** Where an issue is: its page and block ids from the spec, its dotted path, its locale (last segment). */
export function targetOf(spec: unknown, path: readonly (string | number)[]): QualityIssue['target'] {
  const site = spec as { pages?: { id?: string; blocks?: { id?: string }[] }[] } | undefined;
  const page = path[0] === 'pages' && typeof path[1] === 'number' ? site?.pages?.[path[1]] : undefined;
  const block =
    page && path[2] === 'blocks' && typeof path[3] === 'number' ? page.blocks?.[path[3]] : undefined;
  const last = path.at(-1);
  return {
    ...(page?.id ? { pageId: page.id } : {}),
    ...(block?.id ? { blockId: block.id } : {}),
    ...(path.length ? { path: pathString(path) } : {}),
    ...(typeof last === 'string' && LOCALE.test(last) ? { locale: last } : {}),
  };
}

/** The colour the validator suggests for a low-contrast palette entry (`…; try #1f3a5c.`). */
const SUGGESTED = /try (#[0-9a-f]{6})\b/i;

const fromIssue = (gate: QualityGateId, spec: unknown, issue: Issue): QualityIssue => ({
  gate,
  code: issue.code,
  severity: issue.severity,
  message: issue.message.slice(0, 600),
  target: targetOf(spec, issue.path),
  repairable: true,
  // A palette colour with too little contrast, and a nearest colour that has enough: a safe nudge.
  autoFixable: issue.code === 'contrast_low' && SUGGESTED.test(issue.message),
});

const outcome = (issues: QualityIssue[], score?: number): GateOutcome => ({
  status: issues.some((issue) => issue.severity === 'error') ? 'fail' : 'pass',
  ...(score !== undefined ? { score } : {}),
  costUsd: 0,
  issues: issues.slice(0, 500),
});

/** Schema and semantics as a published site would need them (assets on our hosts…); fact issues are the next gate's. */
export const schemaGate: QualityGate = {
  id: 'schema',
  run(ctx) {
    const issues = validateSite(ctx.spec, {
      assetHosts: [...ctx.assetHosts],
      hotlinkHosts: [...ctx.hotlinkHosts],
      mode: 'published',
    }).filter((issue) => !FACT_CODES.has(issue.code));
    return outcome(issues.map((issue) => fromIssue('schema', ctx.spec, issue)));
  },
};

/** Strict facts against the job's registry, with the literal detectors (numbers, phones, prices in free text). */
export const factsGate: QualityGate = {
  id: 'facts',
  run(ctx) {
    const parsed = parseSite(ctx.spec);
    if (!parsed.spec) return outcome([]);
    const issues = validateFacts(parsed.spec, ctx.facts).map((issue) => ({
      ...fromIssue('facts', ctx.spec, issue),
      suggestedFix: 'State only what facts.json says: cite the fact, or remove the claim.',
    }));
    return outcome(issues);
  },
};

/** The lint fixes safe to apply without a model: punctuation spacing and stray whitespace. */
const SAFE_FIXES = new Set(['copy.fr_typography', 'copy.whitespace']);

const fromLint = (spec: unknown, issue: LintIssue, writable: readonly string[]): QualityIssue => ({
  gate: 'copy',
  code: issue.rule,
  severity: issue.severity,
  message: issue.message.slice(0, 600),
  target: { ...targetOf(spec, issue.path), locale: issue.locale },
  ...(issue.hint ? { suggestedFix: issue.hint.slice(0, 400) } : {}),
  repairable: true,
  autoFixable:
    (issue.fix !== undefined &&
      SAFE_FIXES.has(issue.rule) &&
      writable.some((path) => issue.at.startsWith(`${path}.`))) ||
    (issue.rule === 'copy.seo_length' && trimmed(spec, issue) !== undefined),
});

/** Copy lint: errors fail; warnings lower the copy score (the share of written texts without one). */
export const copyGate: QualityGate = {
  id: 'copy',
  run(ctx) {
    const parsed = parseSite(ctx.spec);
    if (!parsed.spec) return outcome([]);
    const writable = copyPaths(parsed.spec);
    const issues = lintCopy(parsed.spec, { config: ctx.config, facts: ctx.facts }).map((issue) =>
      fromLint(ctx.spec, issue, writable),
    );
    // The share of the texts an engine writes that carry no warning (fact values shown verbatim are the facts').
    const flagged = new Set(
      issues
        .filter(
          (issue) =>
            issue.severity === 'warning' &&
            writable.some((path) => issue.target?.path?.startsWith(`${path}.`)),
        )
        .map((issue) => issue.target?.path),
    );
    const texts = Math.max(1, writable.length * parsed.spec.locales.length);
    const score = Math.max(0, Math.round(100 * (1 - flagged.size / texts)));
    return outcome(issues, score);
  },
};

/** A text's value at a lint path (`[...pages, 0, 'seo', 'title', 'fr']`), and its parent to write into. */
function textAt(spec: unknown, path: readonly (string | number)[]) {
  let parent: unknown = spec;
  for (const part of path.slice(0, -1))
    parent = (parent as Record<string | number, unknown> | undefined)?.[part];
  const key = path.at(-1);
  if (!parent || typeof parent !== 'object' || key === undefined) return undefined;
  const value = (parent as Record<string | number, unknown>)[key];
  return typeof value === 'string'
    ? { parent: parent as Record<string | number, unknown>, key, value }
    : undefined;
}

const SEO_MAX = { title: LIMITS.seoTitle.max, description: LIMITS.seoDescription.max } as const;
/** The target lengths' upper bounds (what copy lint asks for): an SEO text is trimmed to them. */
const SEO_TARGET = {
  title: LIMITS.seoTitle.target[1],
  description: LIMITS.seoDescription.target[1],
} as const;

/** An SEO text at most 10% over its target, trimmed at a word boundary (undefined when it does not qualify). */
function trimmed(spec: unknown, issue: LintIssue): string | undefined {
  const kind = issue.path.at(-2);
  if (kind !== 'title' && kind !== 'description') return undefined;
  const text = textAt(spec, issue.path)?.value;
  const target = SEO_TARGET[kind];
  if (!text || text.length <= target || text.length > Math.min(SEO_MAX[kind], target * 1.1)) return undefined;
  const cut = text
    .slice(0, target + 1)
    .replace(/\s+\S*$/, '')
    .replace(/[\s,;:–-]+$/, '');
  return cut.length >= target * 0.6 ? cut : undefined;
}

/**
 * The auto-fixer (BF-045, Command): low-contrast palette colours nudged to the validator's suggestion, typography and
 * whitespace on the texts an engine writes, SEO texts at most 10% over trimmed at a word boundary. Returns the fixed spec and each fix; the caller re-runs the gates once on it.
 */
export function autoFix(
  spec: unknown,
  ctx: Omit<GateContext, 'spec'>,
): { spec: unknown; fixes: QualityAutoFix[] } {
  const parsed = parseSite(spec);
  if (!parsed.spec) return { spec, fixes: [] };
  const fixed = structuredClone(parsed.spec) as SiteSpec;
  const writable = copyPaths(fixed);
  const fixes: QualityAutoFix[] = [];
  // Palette nudges: each low-contrast colour moved to the nearest one with enough contrast (the validator's own).
  for (const issue of validateSite(fixed, {
    assetHosts: [...ctx.assetHosts],
    hotlinkHosts: [...ctx.hotlinkHosts],
    mode: 'published',
  })) {
    const color = issue.code === 'contrast_low' ? SUGGESTED.exec(issue.message)?.[1] : undefined;
    const target = color ? textAt(fixed, issue.path) : undefined;
    if (!color || !target || target.value === color) continue;
    target.parent[target.key] = color;
    fixes.push({ rule: 'contrast_low', path: pathString(issue.path), before: target.value, after: color });
  }
  for (const issue of lintCopy(fixed, { config: ctx.config, facts: ctx.facts })) {
    const target = textAt(fixed, issue.path);
    if (!target) continue;
    let after: string | undefined;
    if (
      issue.fix !== undefined &&
      SAFE_FIXES.has(issue.rule) &&
      writable.some((path) => issue.at.startsWith(`${path}.`))
    )
      after = issue.fix;
    else if (issue.rule === 'copy.seo_length') after = trimmed(fixed, issue);
    if (after === undefined || after === target.value) continue;
    target.parent[target.key] = after;
    fixes.push({
      rule: issue.rule,
      path: issue.at,
      before: target.value.slice(0, 2000),
      after: after.slice(0, 2000),
    });
  }
  return { spec: fixed, fixes: fixes.slice(0, 200) };
}
