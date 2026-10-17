import { loadPromptRegistry, type PromptRegistry } from '@bf/ai';
import { engineFinalReportJsonSchema, type GenerationBrief } from '@bf/contracts';
import { pathString } from '@bf/sitekit';

// What a coding agent finds in its sandbox (BF-044): BF-040's workspace (brief, facts, starter site, context) plus our
// rules — `AGENTS.md` (Codex reads it natively; Claude engines append the same text to their system prompt) — the
// final report's JSON Schema, and in repair mode the site to repair with the gates' issues. Rendering is
// deterministic: the same inputs give the same bundle.

export const RULES_PROMPT = 'generation.site_agent.v1';
export const REPAIR_PROMPT = 'generation.site_agent_repair.v1';
/** Workspace paths the engines' argv refer to. */
export const AGENT_PATHS = {
  rules: '.prompts/rules.md',
  schema: '.prompts/final-report.schema.json',
  report: '.sitekit/final-report.json',
  issuesMd: 'ISSUES.md',
  issuesJson: 'issues.json',
} as const;

export interface RepairInput {
  /** The site the gates sent back (it replaces the starter). */
  readonly spec: unknown;
  readonly issues: readonly unknown[];
}

export interface RenderedWorkspace {
  readonly files: Map<string, Buffer>;
  /** The appended system prompt (the rules, and the repair rules in repair mode). */
  readonly system: string;
  /** The task, as the prompt argument. */
  readonly task: string;
  readonly reportSchema: Record<string, unknown>;
}

let registry: PromptRegistry | undefined;
const prompts = () => {
  registry ??= loadPromptRegistry();
  return registry;
};

/** An issue as one Markdown line: where, then what to change (quoted data stays in backticks). */
function issueLine(issue: unknown): string | undefined {
  if (!issue || typeof issue !== 'object') return undefined;
  const { at, path, message, code } = issue as {
    at?: unknown;
    path?: unknown;
    message?: unknown;
    code?: unknown;
  };
  const where =
    typeof at === 'string'
      ? at
      : Array.isArray(path) && path.every((part) => typeof part === 'string' || typeof part === 'number')
        ? pathString(path as (string | number)[])
        : '';
  if (typeof message !== 'string') return undefined;
  return `- ${typeof code === 'string' ? `[${code}] ` : ''}\`${where || 'site'}\`: ${message.replace(/\s+/g, ' ').slice(0, 400)}`;
}

export function renderAgentWorkspace(
  files: ReadonlyMap<string, Buffer>,
  options: {
    readonly brief: GenerationBrief;
    readonly locales: readonly string[];
    readonly budgetUsd: number;
    readonly maxTurns: number;
    readonly repair?: RepairInput;
  },
): RenderedWorkspace {
  const { brief } = options;
  const variables = {
    business: brief.identity.name,
    category: brief.identity.categoryLabel?.en ?? 'local business',
    locality: brief.identity.locality ?? 'its area',
    locales: options.locales.join(', '),
    pages: brief.pagePlan.pages.map((page) => page.kind).join(', '),
    budget: options.budgetUsd.toFixed(2),
    turns: String(options.maxTurns),
    issueCount: String(options.repair?.issues.length ?? 0),
  };
  const rules = prompts().get(RULES_PROMPT).render(variables);
  const repair = options.repair ? prompts().get(REPAIR_PROMPT).render(variables) : undefined;
  const system = repair ? `${rules.system}\n\n${repair.system}` : rules.system;
  const reportSchema = engineFinalReportJsonSchema();
  const out = new Map(files);
  out.set('AGENTS.md', Buffer.from(`${system}\n`));
  out.set(AGENT_PATHS.rules, Buffer.from(`${system}\n`));
  out.set(AGENT_PATHS.schema, Buffer.from(`${JSON.stringify(reportSchema, null, 2)}\n`));
  if (options.repair) {
    out.set('site.json', Buffer.from(`${JSON.stringify(options.repair.spec, null, 2)}\n`));
    const lines = options.repair.issues.flatMap((issue) => issueLine(issue) ?? []).slice(0, 100);
    out.set(
      AGENT_PATHS.issuesMd,
      Buffer.from(`# Issues to fix\n\n${lines.join('\n') || '- (no detail: run `sitekit check`)'}\n`),
    );
    out.set(
      AGENT_PATHS.issuesJson,
      Buffer.from(`${JSON.stringify(options.repair.issues.slice(0, 100), null, 2)}\n`),
    );
  }
  return { files: out, system, task: (repair ?? rules).user, reportSchema };
}
