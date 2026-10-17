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
import { lintCopy, parseFacts, type SitekitConfig, SitekitConfigSchema, validate } from '@bf/sitekit';
import type { AgentEngine, ArtifactStore, EngineRunContext } from '../../../application/ports.ts';
import {
  applyCopy,
  applyPlan,
  catalogSummary,
  copyFields,
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

  /** Errors (validation with strict facts, then copy lint) and their paths. */
  private check(spec: SiteSpec, workspace: Workspace) {
    const issues = validate(spec, {
      config: workspace.config,
      facts: workspace.facts,
      strictFacts: true,
    }).filter((issue) => issue.severity === 'error');
    const lint = lintCopy(spec, { config: workspace.config, facts: workspace.facts }).filter(
      (issue) => issue.severity === 'error',
    );
    return {
      errors: issues.length + lint.length,
      paths: [...issues.map((issue) => issue.at), ...lint.map((issue) => issue.at)],
    };
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
    try {
      yield { type: 'status', phase: 'running' };
      const workspace = await this.load(ctx);
      const { brief, starter, facts } = workspace;
      yield { type: 'progress', pct: 5, label: 'Read the brief and the facts' };

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
            blocks: page.blocks.map((block) => ({ id: block.id, type: block.type, variant: block.variant })),
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
      if (this.check(planned.spec, workspace).errors > 0) {
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
      for (const warning of plan.warnings) yield { type: 'log', level: 'warn', message: `Plan: ${warning}` };
      yield { type: 'progress', pct: 15, label: 'Planned the pages' };

      // 2. The copy, page by page.
      const spec = planned.spec;
      const displayFacts = facts.facts.map((fact) => ({
        id: fact.id,
        kind: fact.kind,
        value: (typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value)).slice(0, 300),
      }));
      const known = new Set(facts.facts.map((fact) => fact.id));
      const pages = spec.pages
        .map((page) => ({ page, blocks: copyFields(page) }))
        .filter((entry) => entry.blocks.length > 0);
      const copies = await pool(pages, PAGE_CONCURRENCY, async ({ page, blocks }) => {
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
            intent: planned.intents.get(block.blockId) ?? '',
            fields: block.fields.map((field) => ({
              key: field.key,
              maxChars: field.maxChars,
              current: field.current,
            })),
          })),
          facts: displayFacts.slice(0, 120),
          extraInstructions: brief.extraInstructions,
        };
        return {
          pageId: page.id,
          result: await this.gateway.run(GenerationSiteCopy, input, { orgId: ctx.organizationId, signal }),
        };
      });
      const changed: string[] = [];
      let refusedCopy = 0;
      for (const [index, { pageId, result }] of copies.entries()) {
        yield usage(result);
        const applied = applyCopy(spec, pageId, result.output as SiteCopyOutput, known);
        changed.push(...applied.changed);
        refusedCopy += applied.refused.length;
        for (const warning of (result.output as SiteCopyOutput).warnings)
          yield { type: 'log', level: 'warn', message: `Copy (${pageId}): ${warning}` };
        yield {
          type: 'progress',
          pct: 15 + Math.round(((index + 1) / copies.length) * 65),
          label: `Wrote ${pageId}`,
        };
      }
      if (overBudget())
        throw new EngineFailure('BUDGET_EXCEEDED', 'The budget ran out while writing the pages.', false);

      // 3. Self-check: any text that fails goes back to the starter's.
      yield { type: 'status', phase: 'validating' };
      let checked = this.check(spec, workspace);
      let restored: string[] = [];
      if (checked.errors > 0) {
        restored = revertFields(spec, starter, changed, checked.paths);
        checked = this.check(spec, workspace);
      }
      let result = spec;
      if (checked.errors > 0) {
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
        message: `Wrote ${changed.length - restored.length} text(s); ${restored.length} restored to the starter's, ${refusedCopy} refused.`,
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
