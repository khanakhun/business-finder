#!/usr/bin/env node
// A scripted stand-in for a coding agent (BF-043 smoke test): it reports a few events like an agent would, edits
// site.json through sitekit (as real agents must), and exits. No model, no network.
import { execFileSync } from 'node:child_process';

const event = (type, extra = {}) => console.log(JSON.stringify({ type, ...extra }));
event('status', { phase: 'running' });
event('tool_call', { tool: 'sitekit.catalog', summary: 'Read the block catalog' });
const op = {
  op: 'updateText',
  path: ['pages', 0, 'blocks', 0, 'props', 'title'],
  locale: 'fr',
  value: 'Salon de coiffure à Gustavia',
};
const out = execFileSync('sitekit', ['ops', 'apply', '--op', JSON.stringify(op), '--json'], {
  encoding: 'utf8',
});
const result = JSON.parse(out.trim().split('\n').at(-1));
if (!result.ok) {
  console.error(`fake agent: the operation was refused: ${out}`);
  process.exit(1);
}
event('file_change', { path: 'site.json' });
event('done');
