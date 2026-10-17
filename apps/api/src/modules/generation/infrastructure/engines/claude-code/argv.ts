import { AGENT_PATHS } from '../sandboxed/agent-workspace.ts';
import type { AgentRunPlan } from '../sandboxed/sandboxed-agent.engine.ts';

// Claude Code's headless command line (BF-044), verified on CLI 2.1.288 (`claude --help` in the runner image and
// https://code.claude.com/docs/en/cli-reference, /headless, /settings#permission-rules, October 2026):
// - `-p` with `--output-format stream-json` needs `--verbose`;
// - `--permission-mode dontAsk` + `--permission-prompts none`: anything not pre-approved is denied, nothing waits;
// - `--tools` restricts the built-in tools (it does not work with `--bare`, which caps them at Bash/Edit/Read), and
//   `--allowedTools` pre-approves `Bash(sitekit *)` only (a prefix rule on the command as written: `sh -c …`,
//   pipes into other programs and every other command are denied);
// - `--setting-sources=` (none) and `--strict-mcp-config`: no settings or MCP servers but ours;
// - `--json-schema` takes the schema inline (not a file); the final report lands in `result.structured_output`;
// - `--max-budget-usd` is a client-side estimate that can overshoot by a turn: the worker tracks spend as well.

export const WORKSPACE_DIR = '/workspace';

/** Tools the agent has; web, sub-agents, skills and notebooks are not among them. */
export const CLAUDE_CODE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'] as const;
export const CLAUDE_CODE_ALLOWED = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(sitekit *)'] as const;
export const CLAUDE_CODE_DISALLOWED = ['WebFetch', 'WebSearch', 'Task', 'Skill', 'NotebookEdit'] as const;

/** sitekit as shell commands (`Bash(sitekit *)`, the default) or as its MCP server (`sitekit mcp`, no Bash at all). */
export type SitekitAccess = 'bash' | 'mcp';

export function claudeCodeArgv(plan: AgentRunPlan, access: SitekitAccess = 'bash'): string[] {
  const mcp = access === 'mcp';
  const tools = mcp ? CLAUDE_CODE_TOOLS.filter((tool) => tool !== 'Bash') : [...CLAUDE_CODE_TOOLS];
  const allowed = mcp
    ? [...CLAUDE_CODE_ALLOWED.filter((tool) => !tool.startsWith('Bash')), 'mcp__sitekit__*']
    : [...CLAUDE_CODE_ALLOWED];
  return [
    'claude',
    '-p',
    plan.task,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--tools',
    tools.join(','),
    '--allowedTools',
    allowed.join(','),
    '--disallowedTools',
    [...CLAUDE_CODE_DISALLOWED, ...(mcp ? ['Bash'] : [])].join(','),
    '--setting-sources=',
    '--strict-mcp-config',
    ...(mcp
      ? ['--mcp-config', JSON.stringify({ mcpServers: { sitekit: { command: 'sitekit', args: ['mcp'] } } })]
      : []),
    '--append-system-prompt-file',
    `${WORKSPACE_DIR}/${AGENT_PATHS.rules}`,
    '--json-schema',
    JSON.stringify(plan.reportSchema),
    '--model',
    plan.model,
    '--max-turns',
    String(plan.maxTurns),
    '--max-budget-usd',
    plan.budgetUsd.toFixed(2),
    '--no-session-persistence',
  ];
}

/**
 * Telemetry, updates, memory and history off. DECISION(BF-044): not `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` — it needs
 * bubblewrap, which cannot run under the sandbox's seccomp profile (2.1.288 refuses to start a subprocess); the
 * only subprocess the agent may start is sitekit, our own code, in a container that has nothing else to give away.
 */
export const CLAUDE_CODE_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
  DISABLE_BUG_COMMAND: '1',
  DISABLE_COST_WARNINGS: '1',
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  DO_NOT_TRACK: '1',
};
