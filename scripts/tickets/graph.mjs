#!/usr/bin/env node
// Validate the ticket dependency graph and keep derived data in sync.
//
// Usage:
//   node scripts/tickets/graph.mjs            # check only (exit 1 on errors)
//   node scripts/tickets/graph.mjs --write    # also rewrite `blocks:` from `depends_on` and regenerate
//                                             # the generated sections of docs/tickets/README.md
//
// Checks: unique ids matching file names, existing dependencies, no cycles, no dependency on a later milestone,
// `blocks` equal to the reverse of `depends_on`. No external dependencies (Node ≥ 20).

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TICKETS_DIR = join(ROOT, 'docs', 'tickets');
const README = join(TICKETS_DIR, 'README.md');
const WRITE = process.argv.includes('--write');

const MILESTONE_ORDER = ['M0 Foundations', 'M1 Find & List', 'M2 Understand', 'M3 Build', 'M4 Reach', 'M5 Learn & Scale'];

const errors = [];
const warnings = [];

function parse(file) {
  const raw = readFileSync(join(TICKETS_DIR, file), 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error(`${file}: missing frontmatter`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    meta[key] = value.startsWith('[')
      ? value
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : value.trim();
  }
  meta.depends_on ??= [];
  meta.blocks ??= [];
  return { file, raw, meta };
}

const files = readdirSync(TICKETS_DIR)
  .filter((f) => /^BF-\d{3}-.+\.md$/.test(f))
  .sort();
const tickets = files.map(parse);
const byId = new Map();

for (const t of tickets) {
  const idFromFile = t.file.slice(0, 6);
  if (t.meta.id !== idFromFile) errors.push(`${t.file}: id "${t.meta.id}" does not match file name`);
  if (byId.has(t.meta.id)) errors.push(`${t.file}: duplicate id ${t.meta.id}`);
  byId.set(t.meta.id, t);
  if (!MILESTONE_ORDER.includes(t.meta.milestone)) errors.push(`${t.file}: unknown milestone "${t.meta.milestone}"`);
}

// Dependencies exist, are not self-references, and do not point to a later milestone.
for (const t of tickets) {
  for (const dep of t.meta.depends_on) {
    const d = byId.get(dep);
    if (!d) {
      errors.push(`${t.meta.id}: depends on unknown ${dep}`);
      continue;
    }
    if (dep === t.meta.id) errors.push(`${t.meta.id}: depends on itself`);
    const mi = MILESTONE_ORDER.indexOf(t.meta.milestone);
    const di = MILESTONE_ORDER.indexOf(d.meta.milestone);
    if (di > mi) errors.push(`${t.meta.id} (${t.meta.milestone}) depends on ${dep} from a later milestone (${d.meta.milestone})`);
  }
}

// Cycle detection + topological levels ("waves": tickets in the same wave can run in parallel).
const level = new Map();
const visiting = new Set();
function depth(id, stack = []) {
  if (level.has(id)) return level.get(id);
  if (visiting.has(id)) {
    errors.push(`cycle: ${[...stack, id].join(' → ')}`);
    return 0;
  }
  visiting.add(id);
  const t = byId.get(id);
  const deps = (t?.meta.depends_on ?? []).filter((d) => byId.has(d));
  const lv = deps.length ? Math.max(...deps.map((d) => depth(d, [...stack, id]))) + 1 : 0;
  visiting.delete(id);
  level.set(id, lv);
  return lv;
}
for (const t of tickets) depth(t.meta.id);

// Reverse dependencies → expected `blocks`.
const expectedBlocks = new Map(tickets.map((t) => [t.meta.id, []]));
for (const t of tickets) for (const dep of t.meta.depends_on) expectedBlocks.get(dep)?.push(t.meta.id);
for (const [, list] of expectedBlocks) list.sort();

let rewritten = 0;
for (const t of tickets) {
  const want = expectedBlocks.get(t.meta.id);
  const have = [...t.meta.blocks].sort();
  if (want.join(',') === have.join(',')) continue;
  if (WRITE) {
    const updated = t.raw.replace(/^blocks:.*$/m, `blocks: [${want.join(', ')}]`);
    writeFileSync(join(TICKETS_DIR, t.file), updated);
    t.meta.blocks = want;
    rewritten++;
  } else {
    errors.push(`${t.meta.id}: blocks [${have.join(', ')}] ≠ reverse deps [${want.join(', ')}] (run with --write)`);
  }
}

// Soft check: a ticket's own Agent prompt/Context mentions of other tickets that are neither deps nor dependents.
for (const t of tickets) {
  const mentioned = new Set(t.raw.match(/\bBF-\d{3}\b/g) ?? []);
  mentioned.delete(t.meta.id);
  const related = new Set([...t.meta.depends_on, ...expectedBlocks.get(t.meta.id)]);
  const unknown = [...mentioned].filter((id) => !byId.has(id));
  if (unknown.length) warnings.push(`${t.meta.id}: mentions unknown ticket(s) ${unknown.join(', ')}`);
  void related; // mentions of non-adjacent tickets are allowed (context links); only unknown ids are flagged
}

// --- README generation -------------------------------------------------------------------------------------------
function readmeIndex() {
  const rows = tickets.map((t) => {
    const m = t.meta;
    const deps = m.depends_on.length ? m.depends_on.join(', ') : '—';
    return `| [${m.id}](${t.file}) | ${m.title} | ${m.milestone} | ${m.epic} | ${m.priority} | ${m.size} | ${level.get(m.id)} | ${deps} |`;
  });
  return [
    '| Ticket | Title | Milestone | Epic | Priority | Size | Wave | Depends on |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

// Transitive reduction: drop edge dep → t when dep is already an ancestor of another dependency of t.
// Keeps reachability identical with far fewer edges, so the rendered graph stays readable.
function reducedDeps() {
  const ancestors = new Map();
  const anc = (id) => {
    if (ancestors.has(id)) return ancestors.get(id);
    const set = new Set();
    for (const d of byId.get(id)?.meta.depends_on ?? []) {
      if (!byId.has(d)) continue;
      set.add(d);
      for (const a of anc(d)) set.add(a);
    }
    ancestors.set(id, set);
    return set;
  };
  const reduced = new Map();
  for (const t of tickets) {
    const deps = t.meta.depends_on.filter((d) => byId.has(d));
    reduced.set(
      t.meta.id,
      deps.filter((d) => !deps.some((other) => other !== d && anc(other).has(d))),
    );
  }
  return reduced;
}

function readmeGraph() {
  const reduced = reducedDeps();
  const lines = ['```mermaid', 'flowchart TB'];
  for (const ms of MILESTONE_ORDER) {
    const inMs = tickets.filter((t) => t.meta.milestone === ms);
    if (!inMs.length) continue;
    const key = ms.split(' ')[0];
    lines.push(`  subgraph ${key}["${ms}"]`);
    for (const t of inMs) {
      const short = t.meta.title.split(/ — |: |\(/)[0].replace(/["[\]]/g, '').trim();
      lines.push(`    ${t.meta.id.replace('-', '')}["${t.meta.id}<br/>${short}"]`);
    }
    lines.push('  end');
  }
  for (const t of tickets) {
    for (const dep of reduced.get(t.meta.id)) lines.push(`  ${dep.replace('-', '')} --> ${t.meta.id.replace('-', '')}`);
  }
  lines.push('```');
  return lines.join('\n');
}

function readmeWaves() {
  const max = Math.max(...level.values());
  const out = ['| Wave | Tickets that can start once all earlier waves they depend on are merged |', '|---|---|'];
  for (let w = 0; w <= max; w++) {
    const ids = tickets.filter((t) => level.get(t.meta.id) === w).map((t) => t.meta.id);
    out.push(`| ${w} | ${ids.join(', ')} |`);
  }
  return out.join('\n');
}

function replaceSection(text, name, content) {
  const re = new RegExp(`(<!-- ${name}:START -->)[\\s\\S]*?(<!-- ${name}:END -->)`);
  if (!re.test(text)) {
    warnings.push(`README.md: missing <!-- ${name}:START/END --> markers`);
    return text;
  }
  return text.replace(re, `$1\n${content}\n$2`);
}

if (WRITE && existsSync(README)) {
  let text = readFileSync(README, 'utf8');
  text = replaceSection(text, 'INDEX', readmeIndex());
  text = replaceSection(text, 'GRAPH', readmeGraph());
  text = replaceSection(text, 'WAVES', readmeWaves());
  writeFileSync(README, text);
}

for (const w of warnings) console.warn(`warning: ${w}`);
for (const e of errors) console.error(`error: ${e}`);
console.log(
  `${tickets.length} tickets · ${Math.max(...level.values()) + 1} waves · ${errors.length} errors · ${warnings.length} warnings` +
    (WRITE ? ` · blocks rewritten in ${rewritten} file(s)` : ''),
);
process.exit(errors.length ? 1 : 0);
