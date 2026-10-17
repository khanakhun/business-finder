#!/usr/bin/env node
// A scripted stand-in for `codex exec --json` (BF-044 integration tests): it prints Codex 0.160.0's events
// (thread.started, turn.started, items, turn.completed with usage), edits site.json through sitekit as a real agent
// must, writes the last message to the `-o` file, and exits. No model, no network. `FAKE_CODEX_SCENARIO=turn_failed`
// ends like a turn that failed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const print = (event) => console.log(JSON.stringify(event));
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];

print({ type: 'thread.started', thread_id: '01a147a8-0000-7000-8000-00000000fa4e' });
print({ type: 'turn.started' });
const op = {
  op: 'updateText',
  path: ['pages', 0, 'blocks', 0, 'props', 'title'],
  locale: 'fr',
  value: 'Salon Corail, au bord du port',
};
const command = `bash -lc 'sitekit ops apply --op ... --json'`;
print({
  type: 'item.started',
  item: {
    id: 'item_1',
    type: 'command_execution',
    command,
    aggregated_output: '',
    exit_code: null,
    status: 'in_progress',
  },
});
const out = execFileSync('sitekit', ['ops', 'apply', '--op', JSON.stringify(op), '--json'], {
  encoding: 'utf8',
});
print({
  type: 'item.completed',
  item: {
    id: 'item_1',
    type: 'command_execution',
    command,
    aggregated_output: out,
    exit_code: 0,
    status: 'completed',
  },
});
print({
  type: 'item.completed',
  item: {
    id: 'item_2',
    type: 'file_change',
    changes: [{ path: `${process.cwd()}/site.json`, kind: 'update' }],
    status: 'completed',
  },
});
if (process.env.FAKE_CODEX_SCENARIO === 'turn_failed') {
  print({ type: 'turn.failed', error: { message: 'stream disconnected before completion' } });
  process.exit(1);
}
const report = {
  summary: 'Rewrote the hero title from the facts.',
  pagesBuilt: ['/'],
  designDecisions: ['Kept the starter layout'],
  openQuestions: [],
  selfAssessment: { score: 3, reasons: ['A scripted run'] },
};
const last = flag('-o');
if (last) {
  mkdirSync(dirname(last), { recursive: true });
  writeFileSync(last, JSON.stringify(report));
}
print({
  type: 'item.completed',
  item: { id: 'item_3', type: 'agent_message', text: JSON.stringify(report) },
});
print({
  type: 'turn.completed',
  usage: {
    input_tokens: 12000,
    cached_input_tokens: 8000,
    cache_write_input_tokens: 0,
    output_tokens: 900,
    reasoning_output_tokens: 300,
  },
});
