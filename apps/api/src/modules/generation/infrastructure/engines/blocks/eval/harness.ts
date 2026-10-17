import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AiGateway } from '@bf/ai';
import { type EngineEvent, type GenerationBrief, type RegistryFact, RegistryFactSchema } from '@bf/contracts';
import type { SiteSpec } from '@bf/site-schema';
import { lintCopy, parseFacts, SitekitConfigSchema, validate } from '@bf/sitekit';
import type { EngineRunContext } from '../../../../application/ports.ts';
import { copyPaths } from '../../../../domain/blocks/compose.ts';
import { buildBrief } from '../../../../domain/brief/build-brief.ts';
import { buildStarterSpec } from '../../../../domain/brief/starter-spec.ts';
import { toSiteFactRegistry } from '../../../../domain/facts/site-facts.ts';
import { pagePlans } from '../../../page-plans.ts';
import { packBundle } from '../../../workspace/tar.ts';
import { BlocksEngine } from '../blocks.engine.ts';

// The blocks engine's eval harness (BF-041): synthetic businesses (`apps/api/evals/blocks-engine/businesses.json`,
// fake data) become real workspaces (brief, facts, starter site — BF-040's builders), the engine runs on each with a
// gateway (a simulated model in CI, real models in `pnpm --filter @bf/api eval:blocks`), and every result is measured
// the way the quality gate would: validity, fact violations, copy lint, cost and duration.

export const DATASET = new URL('../../../../../../../evals/blocks-engine/businesses.json', import.meta.url);
const ASSET_HOST = 'assets.bf-sites.test';

export interface EvalBusiness {
  readonly id: string;
  readonly tags: readonly string[];
  readonly businessName: string;
  readonly category: { readonly path: string; readonly labels: { en: string; fr: string } };
  readonly locality: string | null;
  readonly countryCode: string;
  readonly siteLanguages: readonly string[];
  readonly hasWebsite: boolean;
  readonly facts: readonly {
    kind: string;
    value: unknown;
    usage?: 'display' | 'internal';
    locale?: string;
  }[];
}

export function loadBusinesses(url: URL = DATASET): EvalBusiness[] {
  return JSON.parse(readFileSync(url, 'utf8')) as EvalBusiness[];
}

/** The business's facts as registry facts, with stable ids (the same business always has the same ids). */
export function registryFacts(business: EvalBusiness): RegistryFact[] {
  return business.facts.map((fact, index) =>
    RegistryFactSchema.parse({
      ...fact,
      id: `fact_${fact.kind}_${createHash('sha256').update(`${business.id}:${index}`).digest('hex').slice(0, 12)}`,
      source: fact.kind === 'category' ? 'golden_record' : 'owner_site',
      sourceRef: `https://${business.id}.example/`,
      confidence: 0.9,
      observedAt: '2026-10-10T08:00:00.000Z',
      usage: fact.usage ?? 'display',
    }),
  );
}

export interface EvalWorkspace {
  readonly brief: GenerationBrief;
  readonly facts: RegistryFact[];
  readonly starter: SiteSpec;
  readonly bundle: Uint8Array;
}

export function evalWorkspace(business: EvalBusiness): EvalWorkspace {
  const facts = registryFacts(business);
  const brief = buildBrief({
    businessId: `0199f6a4-0000-7000-8000-${createHash('sha256').update(business.id).digest('hex').slice(0, 12)}`,
    businessName: business.businessName,
    facts,
    category: business.category,
    locality: business.locality,
    countryCode: business.countryCode,
    hasWebsite: business.hasWebsite,
    reviewThemes: {},
    findings: [],
    workspaceLocales: business.siteLanguages,
    siteLanguages: business.siteLanguages,
    images: { count: 0, large: 0 },
    templates: pagePlans(),
  });
  const { spec } = buildStarterSpec(brief, facts, [], { countryCode: business.countryCode });
  const bundle = packBundle(
    new Map<string, string>([
      ['brief.json', JSON.stringify(brief)],
      ['facts.json', JSON.stringify(toSiteFactRegistry(facts))],
      ['site.json', JSON.stringify(spec)],
      ['.sitekit.json', JSON.stringify({ assetHosts: [ASSET_HOST] })],
    ]),
  );
  return { brief, facts, starter: spec, bundle };
}

export interface Measurement {
  /** No schema, semantic or strict-fact error. */
  readonly valid: boolean;
  readonly errors: number;
  /** Facts the site misstates or invents (fact errors, unsupported literals, invented numbers, superlatives). */
  readonly factViolations: number;
  readonly lintErrors: number;
  readonly lintWarnings: number;
}

const FACT_CODES = new Set(['fact_unknown', 'fact_kind', 'fact_mismatch', 'unsupported_literal']);
const FACT_RULES = new Set(['copy.unsupported_number', 'copy.superlative']);

/** What the quality gate would see: sitekit's validator (strict facts) and copy lint on the result. */
export function measure(spec: unknown, facts: readonly RegistryFact[]): Measurement {
  const registry = parseFacts(toSiteFactRegistry(facts));
  const config = SitekitConfigSchema.parse({ assetHosts: [ASSET_HOST] });
  const issues = validate(spec, { config, facts: registry, strictFacts: true }).filter(
    (issue) => issue.severity === 'error',
  );
  const lint = issues.length === 0 ? lintCopy(spec as SiteSpec, { config, facts: registry }) : [];
  const lintErrors = lint.filter((issue) => issue.severity === 'error');
  // DECISION(BF-041): warnings count on the texts an engine writes (its rewritable fields and the SEO), not on fact
  // values shown verbatim (a French quote in the English locale, a long service name): those are the facts'.
  const written = copyPaths(spec as SiteSpec);
  const warnings = lint.filter(
    (issue) => issue.severity === 'warning' && written.some((path) => issue.at.startsWith(`${path}.`)),
  );
  return {
    valid: issues.length === 0,
    errors: issues.length,
    factViolations:
      issues.filter((issue) => FACT_CODES.has(issue.code)).length +
      lintErrors.filter((issue) => FACT_RULES.has(issue.rule)).length,
    lintErrors: lintErrors.length,
    lintWarnings: warnings.length,
  };
}

export interface EngineRun {
  readonly spec: SiteSpec | undefined;
  readonly events: EngineEvent[];
  readonly durationMs: number;
  readonly costUsd: number;
}

/** One create run of the blocks engine on the business's workspace. */
export async function runEngine(
  workspace: EvalWorkspace,
  gateway: AiGateway,
  options: { budgetUsd?: number; signal?: AbortSignal; now?: () => number } = {},
): Promise<EngineRun> {
  const now = options.now ?? (() => performance.now());
  const engine = new BlocksEngine(gateway, {
    get: async (key) => (key === 'bundle' ? Buffer.from(workspace.bundle) : undefined),
  });
  let spec: SiteSpec | undefined;
  const ctx = {
    jobId: 'eval',
    attemptNo: 1,
    mode: 'create',
    organizationId: 'eval',
    workspace: { bundleRef: 'bundle' },
    brief: {
      businessName: workspace.brief.identity.name,
      pages: workspace.starter.pages.length,
      items: 0,
      locales: workspace.starter.locales,
    },
    budgetUsd: options.budgetUsd ?? 1,
    deadlineAt: new Date(Date.now() + 10 * 60_000),
    locales: workspace.starter.locales,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    writeSpec: async (written: unknown) => {
      spec = written as SiteSpec;
      return 'spec';
    },
  } as unknown as EngineRunContext;
  const events: EngineEvent[] = [];
  const started = now();
  for await (const event of engine.run(ctx, options.signal ?? new AbortController().signal))
    events.push(event);
  const costUsd = events.reduce((sum, event) => sum + (event.type === 'usage' ? (event.costUsd ?? 0) : 0), 0);
  return { spec, events, durationMs: now() - started, costUsd };
}

/** The site's texts, for the judge: every localized free text of every block, and the SEO. */
export function siteTexts(spec: SiteSpec) {
  const texts: { page: string; block: string; field: string; locale: string; text: string }[] = [];
  const visit = (page: string, block: string, field: string, value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) visit(page, block, `${field}[${index}]`, item);
      return;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (
      entries.length > 0 &&
      entries.every(
        ([key, text]) => (spec.locales as readonly string[]).includes(key) && typeof text === 'string',
      )
    ) {
      for (const [locale, text] of entries)
        texts.push({ page, block, field, locale, text: (text as string).slice(0, 2000) });
      return;
    }
    for (const [key, child] of entries) visit(page, block, field ? `${field}.${key}` : key, child);
  };
  for (const page of spec.pages) {
    visit(page.id, 'seo', '', page.seo);
    for (const block of page.blocks) visit(page.id, `${block.type}:${block.id}`, '', block.props);
  }
  return texts.slice(0, 400);
}

const percentile = (values: readonly number[], p: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
};

export interface RowReport {
  readonly id: string;
  readonly tags: readonly string[];
  readonly pages: number;
  readonly locales: readonly string[];
  readonly measurement: Measurement;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly outcome: 'done' | 'error';
  readonly error?: string;
  readonly reasked: number;
  readonly restored: number;
  readonly judged?: Readonly<Record<string, number>>;
}

export interface Summary {
  readonly rows: number;
  readonly validRate: number;
  readonly factViolations: number;
  readonly lintErrors: number;
  readonly maxLintWarnings: number;
  readonly meanCostUsd: number;
  readonly medianCostUsd: number;
  readonly p50DurationMs: number;
  readonly p95DurationMs: number;
  /** Judged criteria (1–5): mean per criterion, the overall mean and the lowest single score. */
  readonly judged?: { readonly means: Record<string, number>; readonly mean: number; readonly min: number };
}

export function summarize(rows: readonly RowReport[]): Summary {
  const costs = rows.map((row) => row.costUsd);
  const durations = rows.map((row) => row.durationMs);
  const judgedRows = rows.filter((row) => row.judged);
  let judged: Summary['judged'];
  if (judgedRows.length > 0) {
    const criteria = Object.keys(judgedRows[0]?.judged ?? {});
    const means = Object.fromEntries(
      criteria.map((name) => [
        name,
        judgedRows.reduce((sum, row) => sum + (row.judged?.[name] ?? 0), 0) / judgedRows.length,
      ]),
    );
    const all = judgedRows.flatMap((row) => Object.values(row.judged ?? {}));
    judged = {
      means,
      mean: all.reduce((sum, value) => sum + value, 0) / all.length,
      min: Math.min(...all),
    };
  }
  return {
    rows: rows.length,
    validRate: rows.length
      ? rows.filter((row) => row.outcome === 'done' && row.measurement.valid).length / rows.length
      : 0,
    factViolations: rows.reduce((sum, row) => sum + row.measurement.factViolations, 0),
    lintErrors: rows.reduce((sum, row) => sum + row.measurement.lintErrors, 0),
    maxLintWarnings: Math.max(0, ...rows.map((row) => row.measurement.lintWarnings)),
    meanCostUsd: costs.reduce((sum, cost) => sum + cost, 0) / Math.max(1, costs.length),
    medianCostUsd: percentile(costs, 50),
    p50DurationMs: percentile(durations, 50),
    p95DurationMs: percentile(durations, 95),
    ...(judged ? { judged } : {}),
  };
}

/**
 * The ticket's thresholds (BF-041 §Evals); judged ones only when the run was judged. `warnings: false` leaves out the
 * per-site warnings cap (the simulated model's template sentences repeat across pages: a style measure needs a model).
 */
export function thresholdFailures(summary: Summary, options: { warnings?: boolean } = {}): string[] {
  const failures: string[] = [];
  if (summary.validRate < 1) failures.push(`valid rate ${summary.validRate.toFixed(3)} < 1`);
  if (summary.factViolations > 0) failures.push(`${summary.factViolations} fact violation(s) > 0`);
  if (summary.lintErrors > 0) failures.push(`${summary.lintErrors} lint error(s) > 0`);
  if (options.warnings !== false && summary.maxLintWarnings > 3)
    failures.push(`${summary.maxLintWarnings} lint warnings on a site > 3`);
  if (summary.judged) {
    if (summary.judged.mean < 4) failures.push(`judged mean ${summary.judged.mean.toFixed(2)} < 4.0`);
    if (summary.judged.min < 3) failures.push(`a judged score of ${summary.judged.min} < 3`);
  }
  return failures;
}

/** Counts from the engine's final log line (`Wrote n text(s); r asked again, s restored…`). */
export function rowReport(
  business: EvalBusiness,
  workspace: EvalWorkspace,
  run: EngineRun,
  judged?: Readonly<Record<string, number>>,
): RowReport {
  const last = run.events.at(-1);
  const summaryLine = run.events.find(
    (event) => event.type === 'log' && /asked again, \d+ restored/.test(event.message),
  );
  const counts =
    summaryLine?.type === 'log' ? /(\d+) asked again, (\d+) restored/.exec(summaryLine.message) : null;
  return {
    id: business.id,
    tags: business.tags,
    pages: run.spec?.pages.length ?? 0,
    locales: workspace.starter.locales,
    measurement: run.spec
      ? measure(run.spec, workspace.facts)
      : { valid: false, errors: 1, factViolations: 0, lintErrors: 0, lintWarnings: 0 },
    costUsd: run.costUsd,
    durationMs: Math.round(run.durationMs),
    outcome: last?.type === 'done' ? 'done' : 'error',
    ...(last?.type === 'error' ? { error: `${last.code}: ${last.message}` } : {}),
    reasked: Number(counts?.[1] ?? 0),
    restored: Number(counts?.[2] ?? 0),
    ...(judged ? { judged } : {}),
  };
}

export function reportMarkdown(mode: string, model: string, rows: readonly RowReport[], summary: Summary) {
  const failures = thresholdFailures(summary, { warnings: mode !== 'simulated' });
  const money = (value: number) => `$${value.toFixed(4)}`;
  const lines = [
    `# blocks engine eval — ${mode} (${model})`,
    '',
    `${failures.length === 0 ? 'PASSED' : 'FAILED'}: ${summary.rows} businesses.`,
    ...failures.map((failure) => `- ${failure}`),
    '',
    '| metric | value | threshold |',
    '|---|---|---|',
    `| valid spec rate | ${(summary.validRate * 100).toFixed(1)}% | 100% |`,
    `| fact violations | ${summary.factViolations} | 0 |`,
    `| lint errors | ${summary.lintErrors} | 0 |`,
    `| lint warnings (worst site) | ${summary.maxLintWarnings} | ≤ 3 |`,
    `| cost mean / median | ${money(summary.meanCostUsd)} / ${money(summary.medianCostUsd)} | median ≤ $0.40 |`,
    `| duration P50 / P95 | ${(summary.p50DurationMs / 1000).toFixed(1)} s / ${(summary.p95DurationMs / 1000).toFixed(1)} s | < 120 s / < 240 s |`,
    ...(summary.judged
      ? [
          `| judged mean (1–5) | ${summary.judged.mean.toFixed(2)} | ≥ 4.0 |`,
          `| judged lowest | ${summary.judged.min} | ≥ 3 |`,
          ...Object.entries(summary.judged.means).map(
            ([name, value]) => `| judged ${name} | ${value.toFixed(2)} | |`,
          ),
        ]
      : []),
    '',
    '| business | tags | pages | valid | facts | lint e/w | asked again | restored | cost | s |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (row) =>
        `| ${row.id} | ${row.tags.join(' ')} | ${row.pages} | ${row.measurement.valid ? 'yes' : `no${row.error ? ` (${row.error.slice(0, 60)})` : ''}`} | ${row.measurement.factViolations} | ${row.measurement.lintErrors}/${row.measurement.lintWarnings} | ${row.reasked} | ${row.restored} | ${money(row.costUsd)} | ${(row.durationMs / 1000).toFixed(1)} |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}
