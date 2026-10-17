import {
  type AiGateway,
  type AiResult,
  GenerationSiteCopy,
  GenerationSitePlan,
  type SiteCopyInput,
  type SiteCopyOutput,
  type SitePlanOutput,
} from '@bf/ai';
import {
  type EngineCapabilities,
  type EngineEvent,
  type GenerationBrief,
  GenerationBriefSchema,
} from '@bf/contracts';
import { type BlockType, CATALOG, type FactRegistry, parseSite, type SiteSpec } from '@bf/site-schema';
import {
  lintCopy,
  parseFacts,
  pathString,
  type SitekitConfig,
  SitekitConfigSchema,
  validate,
} from '@bf/sitekit';
import type { AgentEngine, ArtifactStore, EngineRunContext } from '../../../application/ports.ts';
import {
  applyCopy,
  applyPlan,
  type CopyBlock,
  catalogSummary,
  copyFields,
  copyPaths,
  type FieldProblem,
  fieldProblems,
  type PathIssue,
  restoreBlocks,
  revertFields,
} from '../../../domain/blocks/compose.ts';
import { unpackBundle } from '../../workspace/tar.ts';

// The blocks engine (BF-041): fast and in-process. From the attempt's workspace (BF-040's bundle: brief, facts,
// starter site), a model plans the pages' blocks (order, variants, intents), then writes each page's free text in all
// the site's locales (pages in parallel). Every result is checked — the plan by rules, the copy by sitekit's validator
// and copy lint — and any text that fails goes back to the starter's (valid, neutral) text: the site is always valid.

export const BLOCKS_CAPABILITIES: EngineCapabilities = {
  sandboxed: false,
  supportsRepair: true,
  supportsChatEdit: true,
  maxParallel: 8,
  typicalCostUsd: 0.12,
  typicalDurationSec: 45,
};

const PAGE_CONCURRENCY = 3;
/** Rounds of asking again for the texts that failed the checks, before putting back the starter's. */
const MAX_REASKS = 2;
const REASK_BUDGET_SHARE = 0.8;

interface Workspace {
  readonly brief: GenerationBrief;
  readonly facts: FactRegistry;
  readonly starter: SiteSpec;
  readonly config: SitekitConfig;
}

class EngineFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const json = (files: Map<string, Buffer>, name: string) => {
  const body = files.get(name);
  if (!body) throw new EngineFailure('INVALID_BRIEF', `The workspace has no ${name}.`, false);
  return JSON.parse(body.toString('utf8')) as unknown;
};

type CopyTarget = CopyBlock & { readonly problems?: readonly { key: string; message: string }[] };

/** The quality gate's issues (site-schema's, a path array; or sitekit's, a path string), as data: never trusted. */
function toPathIssues(issues: readonly unknown[]): PathIssue[] {
  return issues.flatMap((issue) => {
    if (!issue || typeof issue !== 'object') return [];
    const { at, path, message } = issue as { at?: unknown; path?: unknown; message?: unknown };
    const where =
      typeof at === 'string'
        ? at
        : Array.isArray(path) && path.every((part) => typeof part === 'string' || typeof part === 'number')
          ? pathString(path as (string | number)[])
          : undefined;
    return where !== undefined && typeof message === 'string'
      ? [{ at: where, message: message.slice(0, 400) }]
      : [];
  });
}

/** Runs tasks with a concurrency cap, in order of results' arrival. */
async function pool<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index] as T);
      }
    }),
  );
  return results;
}

export class BlocksEngine implements AgentEngine {
  readonly id = 'blocks' as const;
  readonly capabilities = BLOCKS_CAPABILITIES;

  constructor(
    private readonly gateway: AiGateway,
    private readonly artifacts: Pick<ArtifactStore, 'get'>,
  ) {}

  async available() {
    return true;
  }

  private async load(ctx: EngineRunContext): Promise<Workspace> {
    const bundle = await this.artifacts.get(ctx.workspace.bundleRef);
    if (!bundle) throw new EngineFailure('INVALID_BRIEF', 'The workspace bundle is missing.', true);
    const files = unpackBundle(bundle);
    const brief = GenerationBriefSchema.parse(json(files, 'brief.json'));
    const facts = parseFacts(json(files, 'facts.json'));
    const parsed = parseSite(json(files, 'site.json'));
    if (!parsed.spec) throw new EngineFailure('INVALID_BRIEF', 'The starter site does not parse.', false);
    const config = SitekitConfigSchema.parse(files.has('.sitekit.json') ? json(files, '.sitekit.json') : {});
    return { brief, facts, starter: parsed.spec, config };
  }

  /** Errors (validation with strict facts, then copy lint), with where they are and what to change. */
  private check(spec: SiteSpec, workspace: Workspace): PathIssue[] {
    const issues = validate(spec, {
      config: workspace.config,
      facts: workspace.facts,
      strictFacts: true,
    }).filter((issue) => issue.severity === 'error');
    const lint = lintCopy(spec, { config: workspace.config, facts: workspace.facts }).filter(
      (issue) => issue.severity === 'error',
    );
    return [...issues, ...lint].map((issue) => ({ at: issue.at, message: issue.message }));
  }

  /** The previous attempt's site, to repair (absent or unreadable: the engine writes a new one). */
  private async base(ctx: EngineRunContext): Promise<SiteSpec | undefined> {
    if (ctx.mode !== 'repair' || !ctx.repair) return undefined;
    const body = await this.artifacts.get(ctx.repair.baseSpecRef).catch(() => undefined);
    if (!body) return undefined;
    try {
      return parseSite(JSON.parse(body.toString('utf8')) as unknown).spec ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * One copy call per page (pages in parallel): every rewritable field, or — with `targets` — only the fields with a
   * problem, each block told what was wrong. Returns, per page, the answer and the paths it may change.
   */
  private async writeCopy(
    ctx: EngineRunContext,
    signal: AbortSignal,
    workspace: Workspace,
    spec: SiteSpec,
    intents: ReadonlyMap<string, string>,
    targets?: readonly FieldProblem[],
  ) {
    const { brief, facts } = workspace;
    const displayFacts = facts.facts.map((fact) => ({
      id: fact.id,
      kind: fact.kind,
      value: (typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value)).slice(0, 300),
    }));
    const pages = spec.pages
      .map((page) => {
        const blocks = copyFields(page).flatMap((block): CopyTarget[] => {
          if (!targets) return [block];
          const problems = targets.filter(
            (target) => target.pageId === page.id && target.blockId === block.blockId,
          );
          const fields = block.fields.filter((field) =>
            problems.some((problem) => problem.key === field.key),
          );
          return fields.length
            ? [{ ...block, fields, problems: problems.map(({ key, message }) => ({ key, message })) }]
            : [];
        });
        const only = targets
          ? new Set(targets.filter((target) => target.pageId === page.id).map((target) => target.path))
          : undefined;
        return { page, blocks, only };
      })
      .filter((entry) => entry.blocks.length > 0);
    return pool(pages, PAGE_CONCURRENCY, async ({ page, blocks, only }) => {
      const input: SiteCopyInput = {
        business: {
          name: brief.identity.name,
          category: brief.identity.categoryLabel?.en ?? null,
          locality: brief.identity.locality,
        },
        locales: spec.locales,
        tone: brief.constraints.tone,
        market: brief.audience.market,
        sellingPoints: brief.sellingPoints.map((point) => point.text),
        doNotMention: brief.constraints.doNotMention,
        page: { id: page.id, kind: page.id },
        blocks: blocks.map((block) => ({
          blockId: block.blockId,
          type: block.type,
          intent: intents.get(block.blockId) ?? '',
          fields: block.fields.map((field) => ({
            key: field.key,
            maxChars: field.maxChars,
            current: field.current,
          })),
          ...(block.problems ? { problems: block.problems.slice(0, 12) } : {}),
        })),
        facts: displayFacts.slice(0, 120),
        extraInstructions: brief.extraInstructions,
      };
      return {
        pageId: page.id,
        only,
        result: await this.gateway.run(GenerationSiteCopy, input, { orgId: ctx.organizationId, signal }),
      };
    });
  }

  async *run(ctx: EngineRunContext, signal: AbortSignal): AsyncIterable<EngineEvent> {
    let spent = 0;
    const usage = (result: AiResult<unknown>): EngineEvent => {
      const costUsd = result.costUsd ?? 0;
      spent += costUsd;
      return {
        type: 'usage',
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUsd,
      };
    };
    const overBudget = () => ctx.budgetUsd !== null && ctx.budgetUsd !== undefined && spent > ctx.budgetUsd;
    // DECISION(BF-041): a re-ask starts only below 80% of the budget, so it cannot take the attempt far over it; past
    // that, failing texts go straight back to the starter's.
    const nearBudget = () =>
      ctx.budgetUsd !== null && ctx.budgetUsd !== undefined && spent >= ctx.budgetUsd * REASK_BUDGET_SHARE;
    try {
      yield { type: 'status', phase: 'running' };
      const workspace = await this.load(ctx);
      const { brief, starter, facts } = workspace;
      const known = new Set(facts.facts.map((fact) => fact.id));
      yield { type: 'progress', pct: 5, label: 'Read the brief and the facts' };

      const changed = new Set<string>();
      let refusedCopy = 0;
      /** Applies each page's answer (within its allowed paths), with its usage, warnings and progress events. */
      const apply = function* (
        spec: SiteSpec,
        copies: Awaited<ReturnType<BlocksEngine['writeCopy']>>,
        from: number,
        to: number,
      ): Generator<EngineEvent> {
        for (const [index, { pageId, only, result }] of copies.entries()) {
          yield usage(result);
          const answer = result.output as SiteCopyOutput;
          const applied = applyCopy(spec, pageId, answer, known, only);
          for (const path of applied.changed) changed.add(path);
          refusedCopy += applied.refused.length;
          for (const warning of answer.warnings)
            yield { type: 'log', level: 'warn', message: `Copy (${pageId}): ${warning}` };
          yield {
            type: 'progress',
            pct: from + Math.round(((index + 1) / copies.length) * (to - from)),
            label: `Wrote ${pageId}`,
          };
        }
      };

      let spec: SiteSpec;
      let intents: ReadonlyMap<string, string> = new Map();
      const base = await this.base(ctx);
      if (base) {
        // Repair (BF-041): the previous site, its failing texts written again with what was wrong, any other failing
        // block put back to the starter's.
        spec = base;
        const reported = toPathIssues(ctx.repair?.issues ?? []);
        const restoredBlocks = restoreBlocks(spec, starter, reported);
        for (const path of copyPaths(spec)) changed.add(path);
        const problems = fieldProblems(spec, reported);
        yield {
          type: 'log',
          level: 'info',
          message: `Repairing ${reported.length} issue(s): ${problems.length} text(s) to rewrite, ${restoredBlocks.length} block(s) restored.`,
        };
        if (problems.length > 0) {
          const copies = await this.writeCopy(ctx, signal, workspace, spec, intents, problems);
          yield* apply(spec, copies, 15, 80);
        }
      } else {
        if (ctx.mode === 'repair')
          yield { type: 'log', level: 'warn', message: 'No previous site to repair: writing a new one.' };
        // 1. The plan.
        const factCounts: Record<string, number> = {};
        for (const fact of facts.facts) factCounts[fact.kind] = (factCounts[fact.kind] ?? 0) + 1;
        const planResult = await this.gateway.run(
          GenerationSitePlan,
          {
            business: {
              name: brief.identity.name,
              category: brief.identity.categoryLabel?.en ?? null,
              locality: brief.identity.locality,
              description: brief.identity.description,
            },
            locales: starter.locales,
            market: brief.audience.market,
            tone: brief.constraints.tone,
            sellingPoints: brief.sellingPoints.map((point) => point.text),
            painPoints: brief.painPoints.map((pain) => pain.remedy),
            pages: starter.pages.map((page) => ({
              id: page.id,
              kind: page.id,
              blocks: page.blocks.map((block) => ({
                id: block.id,
                type: block.type,
                variant: block.variant,
              })),
            })),
            catalog: catalogSummary(
              starter.pages.flatMap((page) => page.blocks.map((block) => block.type)),
              (type: BlockType) => ({ ...CATALOG[type].variants }),
            ),
            facts: factCounts,
            extraInstructions: brief.extraInstructions,
          },
          { orgId: ctx.organizationId, signal },
        );
        yield usage(planResult);
        if (overBudget())
          throw new EngineFailure('BUDGET_EXCEEDED', 'The budget ran out after the plan.', false);
        const plan = planResult.output as SitePlanOutput;
        let planned = applyPlan(starter, plan.pages);
        if (this.check(planned.spec, workspace).length > 0) {
          // A plan whose variants the site cannot carry (an image variant without an image…): keep the starter's layout.
          planned = {
            spec: structuredClone(starter),
            intents: planned.intents,
            refused: [...planned.refused, 'plan reverted'],
          };
        }
        yield {
          type: 'log',
          level: 'info',
          message: `Planned ${planned.spec.pages.length} page(s): ${planned.spec.pages.map((page) => page.id).join(', ')}${planned.refused.length ? ` (${planned.refused.length} choice(s) refused)` : ''}`,
        };
        for (const warning of plan.warnings)
          yield { type: 'log', level: 'warn', message: `Plan: ${warning}` };
        yield { type: 'progress', pct: 15, label: 'Planned the pages' };

        // 2. The copy, page by page.
        spec = planned.spec;
        intents = planned.intents;
        const copies = await this.writeCopy(ctx, signal, workspace, spec, intents);
        yield* apply(spec, copies, 15, 80);
      }
      if (overBudget())
        throw new EngineFailure('BUDGET_EXCEEDED', 'The budget ran out while writing the pages.', false);

      // 3. Self-check: a text that fails is asked again with what was wrong (while the budget allows), then put back
      // to the starter's.
      yield { type: 'status', phase: 'validating' };
      let issues = this.check(spec, workspace);
      let reasked = 0;
      for (let round = 0; round < MAX_REASKS && issues.length > 0; round++) {
        const problems = fieldProblems(spec, issues).filter((problem) => changed.has(problem.path));
        if (problems.length === 0 || nearBudget()) break;
        reasked += problems.length;
        yield {
          type: 'log',
          level: 'info',
          message: `Asking again for ${problems.length} text(s) that failed the checks.`,
        };
        const copies = await this.writeCopy(ctx, signal, workspace, spec, intents, problems);
        yield* apply(spec, copies, 80 + round * 5, 85 + round * 5);
        issues = this.check(spec, workspace);
      }
      let restored: string[] = [];
      if (issues.length > 0) {
        restored = revertFields(
          spec,
          starter,
          [...changed],
          issues.map((issue) => issue.at),
        );
        issues = this.check(spec, workspace);
      }
      let result = spec;
      if (issues.length > 0) {
        // Never ship an invalid site: the starter is valid by construction (BF-040).
        result = structuredClone(starter);
        yield {
          type: 'log',
          level: 'warn',
          message: 'The written site still had errors: kept the starter site.',
        };
      }
      yield {
        type: 'log',
        level: 'info',
        message: `Wrote ${changed.size - restored.length} text(s); ${reasked} asked again, ${restored.length} restored to the starter's, ${refusedCopy} refused.`,
      };
      yield { type: 'progress', pct: 95, label: 'Checked the site' };
      const ref = await ctx.writeSpec(result);
      yield { type: 'file_change', path: 'site.json' };
      yield { type: 'artifact', kind: 'site_spec', ref };
      yield { type: 'progress', pct: 100, label: 'Done' };
      yield { type: 'done', siteSpecRef: ref };
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof EngineFailure) {
        yield { type: 'error', code: error.code, message: error.message, retryable: error.retryable };
        return;
      }
      yield {
        type: 'error',
        code: 'PROVIDER_ERROR',
        message: `The blocks engine failed: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          1000,
        ),
        retryable: true,
      };
    }
  }
}
