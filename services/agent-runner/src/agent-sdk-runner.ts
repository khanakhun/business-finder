// The Claude Agent SDK's side of the `claude-agent-sdk` engine (BF-044), run inside the sandbox by the supervisor:
// `node /opt/runner/agent-sdk-runner.mjs --task … --rules … --schema … --model … --max-turns … --max-budget-usd …`.
// It calls `query()` (SDK 0.3.288, pinned to the image's Claude Code 2.1.288 through `pathToClaudeCodeExecutable`)
// with least privilege — file tools and sitekit's MCP server, no shell, no web, no settings, prompts denied — and a
// PreToolUse hook that refuses any path outside the workspace, then prints every SDK message as one JSON line: the
// same wire format as `claude -p --output-format stream-json`, so the engine reuses Claude Code's parser.
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type HookCallback, query } from '@anthropic-ai/claude-agent-sdk';

export const CLAUDE_CODE_EXECUTABLE = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
export const SDK_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
export const SDK_DISALLOWED = ['Bash', 'WebFetch', 'WebSearch', 'Task', 'Skill', 'NotebookEdit'];

/** Whether a tool input's path stays inside the workspace (relative paths are resolved against it). */
export function insideWorkspace(workspace: string, path: string): boolean {
  const rel = relative(workspace, resolve(workspace, path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The path-like fields of a file tool's input. */
const pathsOf = (input: unknown): string[] => {
  if (!input || typeof input !== 'object') return [];
  const record = input as Record<string, unknown>;
  return ['file_path', 'path', 'notebook_path'].flatMap((key) =>
    typeof record[key] === 'string' ? [record[key] as string] : [],
  );
};

/** Denies a tool call whose path leaves the workspace; anything else goes on to the normal permission rules. */
export function workspaceGuard(workspace: string, log: (line: string) => void): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const outside = pathsOf(input.tool_input).find((path) => !insideWorkspace(workspace, path));
    if (!outside) return {};
    log(`denied ${input.tool_name}: ${outside} is outside the workspace`);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Only files inside the workspace may be read or written.',
      },
    };
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      task: { type: 'string' },
      rules: { type: 'string' },
      schema: { type: 'string' },
      model: { type: 'string' },
      'max-turns': { type: 'string' },
      'max-budget-usd': { type: 'string' },
    },
  });
  if (!values.task || !values.rules || !values.schema || !values.model) {
    process.stderr.write('agent-sdk-runner: --task, --rules, --schema and --model are required\n');
    return 2;
  }
  const workspace = process.cwd();
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  const log = (line: string) => process.stderr.write(`agent-sdk-runner: ${line}\n`);
  const run = query({
    prompt: values.task,
    options: {
      cwd: workspace,
      model: values.model,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: readFileSync(values.rules, 'utf8') },
      tools: SDK_TOOLS,
      allowedTools: [...SDK_TOOLS, 'mcp__sitekit__*'],
      disallowedTools: SDK_DISALLOWED,
      permissionMode: 'dontAsk',
      permissionPrompts: 'none',
      hooks: { PreToolUse: [{ hooks: [workspaceGuard(workspace, log)] }] },
      mcpServers: { sitekit: { type: 'stdio', command: 'sitekit', args: ['mcp'] } },
      strictMcpConfig: true,
      settingSources: [],
      outputFormat: { type: 'json_schema', schema: JSON.parse(readFileSync(values.schema, 'utf8')) },
      maxTurns: Number(values['max-turns'] ?? 60),
      maxBudgetUsd: Number(values['max-budget-usd'] ?? 1),
      persistSession: false,
      abortController: controller,
      pathToClaudeCodeExecutable: CLAUDE_CODE_EXECUTABLE,
      // `env` replaces the CLI's environment: pass ours on (the key, telemetry and updates off).
      env: { ...process.env },
      stderr: (data) => process.stderr.write(data),
    },
  });
  let failed = true;
  for await (const message of run) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
    if (message.type === 'result') failed = message.is_error;
  }
  return failed ? 1 : 0;
}

// Run only as the program (the tests import the guard).
if (process.argv[1]?.endsWith('agent-sdk-runner.mjs'))
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`agent-sdk-runner: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 3;
    },
  );
