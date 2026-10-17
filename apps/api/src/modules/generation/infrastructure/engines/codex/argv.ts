import { WORKSPACE_DIR } from '../claude-code/argv.ts';
import { AGENT_PATHS } from '../sandboxed/agent-workspace.ts';
import type { AgentRunPlan } from '../sandboxed/sandboxed-agent.engine.ts';

// Codex's non-interactive command line (BF-044), verified on Codex CLI 0.160.0 (`codex exec --help` in the runner
// image; https://developers.openai.com/codex/noninteractive and the `rust-v0.160.0` sources, October 2026):
// - `exec --json`: JSONL events on stdout (logs on stderr); `exec` already runs with `approval_policy = never`;
// - `--skip-git-repo-check`: the workspace is not a git repository;
// - `--output-schema <file>` + `-o <file>`: the final message is the report, as JSON;
// - `--ephemeral`, `history.persistence = "none"`, `analytics.enabled = false`, no update check, web search off;
// - `shell_environment_policy.inherit = "core"`: the commands it runs (sitekit) get a minimal env, not CODEX_API_KEY;
// - `--dangerously-bypass-approvals-and-sandbox`: Codex's own sandbox cannot run inside ours (bubblewrap needs user
//   namespaces, which Docker's default seccomp profile refuses; the Landlock fallback panics in 0.160.0). The flag is
//   documented for "environments that are externally sandboxed" — our container is (ADR-0010 addendum, BF-044).
// Codex reads the workspace's AGENTS.md (our rules) on its own; the task is the prompt argument.

export interface CodexOptions {
  readonly reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
}

export function codexArgv(plan: AgentRunPlan, options: CodexOptions): string[] {
  return [
    'codex',
    'exec',
    plan.task,
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '--ephemeral',
    '--output-schema',
    `${WORKSPACE_DIR}/${AGENT_PATHS.schema}`,
    '-o',
    `${WORKSPACE_DIR}/${AGENT_PATHS.report}`,
    '-m',
    plan.model,
    '-C',
    WORKSPACE_DIR,
    '-c',
    `model_reasoning_effort="${options.reasoningEffort}"`,
    '-c',
    'analytics.enabled=false',
    '-c',
    'check_for_update_on_startup=false',
    '-c',
    'history.persistence="none"',
    '-c',
    'web_search="disabled"',
    '-c',
    'shell_environment_policy.inherit="core"',
  ];
}
