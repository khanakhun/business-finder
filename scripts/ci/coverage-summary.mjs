#!/usr/bin/env node
// Collects coverage summaries written by the test tasks into one Markdown table (CI appends it to the job
// summary). Thresholds are enforced by the test runners themselves (Vitest per package, pytest-cov ≥ 85 %); this
// only reports. Reads `<workspace>/coverage/coverage-summary.json` (Istanbul) and `coverage/coverage.json`
// (coverage.py).
import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pct = (value) => (typeof value === 'number' ? `${value.toFixed(1)} %` : '—');

/** One row per workspace that produced a coverage report: `{ workspace, lines, branches }`. */
export function collect(root) {
  const rows = [];
  for (const file of globSync(['{apps,packages,services}/*/coverage/coverage-summary.json'], { cwd: root })) {
    const { total } = JSON.parse(readFileSync(join(root, file), 'utf8'));
    rows.push({
      workspace: dirname(dirname(file)),
      lines: total?.lines?.pct,
      branches: total?.branches?.pct,
    });
  }
  for (const file of globSync(['services/*/coverage/coverage.json'], { cwd: root })) {
    const { totals } = JSON.parse(readFileSync(join(root, file), 'utf8'));
    const branches = totals?.num_branches ? (100 * totals.covered_branches) / totals.num_branches : undefined;
    rows.push({ workspace: dirname(dirname(file)), lines: totals?.percent_covered, branches });
  }
  return rows.sort((a, b) => a.workspace.localeCompare(b.workspace));
}

export function toMarkdown(rows) {
  if (rows.length === 0) return '### Coverage\n\nNo coverage reports (no affected package ran its tests).\n';
  const lines = rows.map((r) => `| \`${r.workspace}\` | ${pct(r.lines)} | ${pct(r.branches)} |`);
  return ['### Coverage', '', '| Workspace | Lines | Branches |', '|---|---:|---:|', ...lines, ''].join('\n');
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const markdown = toMarkdown(collect(root));
  console.log(markdown);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary && existsSync(dirname(summary))) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(summary, `${markdown}\n`);
  }
}
