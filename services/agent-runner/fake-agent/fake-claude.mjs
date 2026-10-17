#!/usr/bin/env node
// A scripted stand-in for `claude -p --output-format stream-json` (BF-044 integration tests): it speaks Claude Code
// 2.1.x's stream format (system init, assistant tool_use, user tool_result, result with structured output), edits
// site.json through sitekit as a real agent must, and exits. No model, no network. `FAKE_CLAUDE_SCENARIO=max_turns`
// ends like an agent that ran out of turns.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const session = randomUUID();
const print = (message) =>
  console.log(JSON.stringify({ ...message, session_id: session, uuid: randomUUID() }));
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const model = flag('--model') ?? 'claude-opus-5-5';

print({
  type: 'system',
  subtype: 'init',
  cwd: process.cwd(),
  tools: (flag('--tools') ?? '').split(',').filter(Boolean),
  mcp_servers: [],
  model,
  permissionMode: flag('--permission-mode') ?? 'default',
  apiKeySource: process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'none',
  claude_code_version: '2.1.288',
});

const op = {
  op: 'updateText',
  path: ['pages', 0, 'blocks', 0, 'props', 'title'],
  locale: 'fr',
  value: 'Salon Corail, sur le port de Gustavia',
};
const command = `sitekit ops apply --op '${JSON.stringify(op)}' --json`;
print({
  type: 'assistant',
  message: {
    id: 'msg_fake_1',
    type: 'message',
    role: 'assistant',
    model,
    content: [
      { type: 'text', text: 'Rewriting the hero title.' },
      { type: 'tool_use', id: 'toolu_fake_1', name: 'Bash', input: { command } },
    ],
    usage: {
      input_tokens: 1800,
      output_tokens: 240,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  },
  parent_tool_use_id: null,
});
const out = execFileSync('sitekit', ['ops', 'apply', '--op', JSON.stringify(op), '--json'], {
  encoding: 'utf8',
});
print({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_fake_1', content: out.trim(), is_error: false }],
  },
  parent_tool_use_id: null,
});

const usage = {
  input_tokens: 1800,
  output_tokens: 240,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};
if (process.env.FAKE_CLAUDE_SCENARIO === 'max_turns') {
  print({
    type: 'result',
    subtype: 'error_max_turns',
    is_error: true,
    num_turns: 2,
    duration_ms: 50,
    total_cost_usd: 0.02,
    usage,
    errors: ['Reached maximum number of turns (2)'],
  });
  process.exit(1);
}
const report = {
  summary: 'Rewrote the hero title from the facts.',
  pagesBuilt: ['/'],
  designDecisions: ['Kept the starter layout'],
  openQuestions: [],
  selfAssessment: { score: 3, reasons: ['A scripted run'] },
};
print({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 2,
  duration_ms: 50,
  total_cost_usd: 0.02,
  usage,
  result: JSON.stringify(report),
  structured_output: report,
  permission_denials: [],
});
