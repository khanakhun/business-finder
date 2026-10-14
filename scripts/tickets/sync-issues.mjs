#!/usr/bin/env node
// Sync docs/tickets/BF-*.md → GitHub issues (labels, milestones, cross-links).
//
// Usage:
//   node scripts/tickets/sync-issues.mjs [--repo owner/name] [--dry-run] [--only BF-001,BF-002] [--refresh-ready]
//
// Requires the GitHub CLI (`gh`) authenticated for the repo. Uses only REST endpoints.
// Idempotent: existing issues (from docs/tickets/issue-map.json or matched by title) are updated, not duplicated.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TICKETS_DIR = join(ROOT, 'docs', 'tickets');
const MAP_FILE = join(TICKETS_DIR, 'issue-map.json');
const WRITE_DELAY_MS = 1100; // stay well under GitHub's content-creation secondary rate limit

const MILESTONES = {
  'M0 Foundations':
    'Monorepo, infrastructure, database, contracts, observability, API/web/intel skeletons, CI.',
  'M1 Find & List':
    'Accounts & workspaces, business graph, discovery providers, AI search, listing UI, CRM basics, staging.',
  'M2 Understand': 'Website intelligence, enrichment, email verification, review mining, audits, scoring.',
  'M3 Build':
    'Website platform (SiteSpec, blocks, renderer, editor) and one-click AI site generation with multiple engines.',
  'M4 Reach':
    'Compliance engine, mailboxes, AI drafting, one-click send, sequences, reply triage, deliverability.',
  'M5 Learn & Scale':
    'Analytics, outcome-trained scoring, security hardening, production operations, live sites with custom domains and client handover.',
};

const LABEL_COLORS = {
  ticket: '5319e7',
  'agent:ready': '0e8a16',
  epic: '1d76db',
  priority: 'b60205',
  size: 'c5def5',
  type: 'fbca04',
  area: 'bfdadc',
};

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY = flag('--dry-run');
const ONLY = opt('--only')
  ?.split(',')
  .map((s) => s.trim());
const REFRESH_READY = flag('--refresh-ready');
const REPO = opt('--repo') ?? detectRepo();

function detectRepo() {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)(\.git)?$/);
  if (!m) throw new Error(`Cannot detect GitHub repo from origin URL: ${url}`);
  return m[1];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Retries: rate limits (request rejected, safe to repeat for any method) wait ≥ 1 minute as GitHub recommends;
// 5xx errors are retried only for idempotent methods so a POST can never create a duplicate issue.
function gh(method, path, body, attempt = 0) {
  const ghArgs = ['api', '-X', method, `repos/${REPO}${path}`, '-H', 'Accept: application/vnd.github+json'];
  if (body !== undefined) ghArgs.push('--input', '-');
  try {
    const out = execFileSync('gh', ghArgs, {
      input: body !== undefined ? JSON.stringify(body) : undefined,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim() ? JSON.parse(out) : null;
  } catch (err) {
    const msg = `${err.stderr ?? ''} ${err.stdout ?? ''} ${err.message ?? ''}`;
    const rateLimited = /rate limit|HTTP 429/i.test(msg);
    const serverError = /HTTP 50[0234]/.test(msg) && method !== 'POST';
    if ((rateLimited || serverError) && attempt < 5) {
      const waitMs = rateLimited ? 60_000 * (attempt + 1) : 5_000 * (attempt + 1);
      console.warn(
        `! ${method} ${path}: ${rateLimited ? 'rate limited' : 'server error'}; retrying in ${waitMs / 1000}s`,
      );
      sleepSync(waitMs);
      return gh(method, path, body, attempt + 1);
    }
    throw err;
  }
}

function ghPaginate(path) {
  const results = [];
  for (let page = 1; page < 50; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const batch = gh('GET', `${path}${sep}per_page=100&page=${page}`);
    results.push(...batch);
    if (batch.length < 100) break;
  }
  return results;
}

// --- frontmatter (controlled subset of YAML: `key: value` and `key: [a, b]`) ---
function parseTicket(file) {
  const raw = readFileSync(join(TICKETS_DIR, file), 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing frontmatter`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value.startsWith('[')) {
      meta[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      meta[key] = value.trim();
    }
  }
  for (const required of ['id', 'title', 'milestone', 'epic', 'type', 'priority', 'size']) {
    if (!meta[required]) throw new Error(`${file}: frontmatter missing "${required}"`);
  }
  meta.depends_on ??= [];
  meta.blocks ??= [];
  meta.areas ??= [];
  // Body without the H1 title line (the issue title carries it).
  const body = m[2].replace(/^\s*#\s+.*\n+/, '');
  return { file, meta, body };
}

function labelsFor(meta, ready) {
  const labels = [
    'ticket',
    `epic:${meta.epic}`,
    `priority:${meta.priority}`,
    `size:${meta.size}`,
    `type:${meta.type}`,
  ];
  for (const a of meta.areas) labels.push(`area:${a}`);
  if (ready) labels.push('agent:ready');
  return labels;
}

function colorFor(label) {
  const prefix = label.includes(':') && label !== 'agent:ready' ? label.split(':')[0] : label;
  return LABEL_COLORS[prefix] ?? 'ededed';
}

// Replace BF-NNN with "BF-NNN (#n)" outside fenced code blocks.
function linkify(text, map) {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part) =>
      part.startsWith('```')
        ? part
        : part.replace(/\bBF-(\d{3})\b(?! \(#)/g, (whole) =>
            map[whole] ? `${whole} (#${map[whole]})` : whole,
          ),
    )
    .join('');
}

function buildBody(t, map) {
  const ref = (id) => (map[id] ? `${id} (#${map[id]})` : id);
  const deps = t.meta.depends_on.length ? t.meta.depends_on.map(ref).join(', ') : '—';
  const blocks = t.meta.blocks.length ? t.meta.blocks.map(ref).join(', ') : '—';
  const header = [
    `> 📄 **Source of truth:** [\`docs/tickets/${t.file}\`](https://github.com/${REPO}/blob/main/docs/tickets/${t.file}) — edit the file, then run \`node scripts/tickets/sync-issues.mjs\`.`,
    '',
    '| Milestone | Epic | Priority | Size | Depends on | Blocks |',
    '|---|---|---|---|---|---|',
    `| ${t.meta.milestone} | ${t.meta.epic} | ${t.meta.priority} | ${t.meta.size} | ${deps} | ${blocks} |`,
    '',
  ].join('\n');
  return `${header}\n${linkify(t.body, map)}`;
}

async function main() {
  const files = readdirSync(TICKETS_DIR)
    .filter((f) => /^BF-\d{3}-.+\.md$/.test(f))
    .sort();
  let tickets = files.map(parseTicket);
  if (ONLY) tickets = tickets.filter((t) => ONLY.includes(t.meta.id));

  const map = existsSync(MAP_FILE) ? JSON.parse(readFileSync(MAP_FILE, 'utf8')) : {};
  console.log(`Repo: ${REPO} · tickets: ${tickets.length} · dry-run: ${DRY}`);

  // Readiness: no dependencies, or all dependency issues closed (with --refresh-ready).
  const closed = new Set();
  if (REFRESH_READY) {
    for (const issue of ghPaginate('/issues?state=closed&labels=ticket')) {
      const id = issue.title.match(/^(BF-\d{3})/)?.[1];
      if (id) closed.add(id);
    }
  }
  const isReady = (t) => t.meta.depends_on.every((d) => closed.has(d));

  // Labels
  const existingLabels = new Set(ghPaginate('/labels').map((l) => l.name));
  const wantedLabels = new Set(tickets.flatMap((t) => labelsFor(t.meta, true)));
  for (const name of wantedLabels) {
    if (existingLabels.has(name)) continue;
    console.log(`+ label ${name}`);
    if (!DRY) {
      gh('POST', '/labels', { name, color: colorFor(name) });
      await sleep(WRITE_DELAY_MS);
    }
  }

  // Milestones
  const milestones = Object.fromEntries(ghPaginate('/milestones?state=all').map((m) => [m.title, m.number]));
  for (const title of new Set(tickets.map((t) => t.meta.milestone))) {
    if (milestones[title]) continue;
    console.log(`+ milestone ${title}`);
    if (!DRY) {
      const created = gh('POST', '/milestones', { title, description: MILESTONES[title] ?? '' });
      milestones[title] = created.number;
      await sleep(WRITE_DELAY_MS);
    }
  }

  // Match existing issues by title prefix to avoid duplicates if the map is missing.
  const existingIssues = ghPaginate('/issues?state=all&labels=ticket');
  for (const issue of existingIssues) {
    const id = issue.title.match(/^(BF-\d{3})/)?.[1];
    if (id && !map[id]) map[id] = issue.number;
  }

  // Pass 1: create missing issues (in id order so numbers follow ticket order on a fresh repo).
  for (const t of tickets) {
    if (map[t.meta.id]) continue;
    console.log(`+ issue ${t.meta.id}`);
    if (DRY) continue;
    const created = gh('POST', '/issues', {
      title: `${t.meta.id}: ${t.meta.title}`,
      body: 'Syncing…',
      labels: labelsFor(t.meta, isReady(t)),
      milestone: milestones[t.meta.milestone],
    });
    map[t.meta.id] = created.number;
    writeFileSync(MAP_FILE, `${JSON.stringify(sortKeys(map), null, 2)}\n`);
    await sleep(WRITE_DELAY_MS);
  }

  // Pass 2: write final bodies with cross-links, labels and milestone.
  for (const t of tickets) {
    const number = map[t.meta.id];
    if (!number) continue;
    console.log(`~ issue #${number} ${t.meta.id}`);
    if (DRY) continue;
    gh('PATCH', `/issues/${number}`, {
      title: `${t.meta.id}: ${t.meta.title}`,
      body: buildBody(t, map),
      labels: labelsFor(t.meta, isReady(t)),
      milestone: milestones[t.meta.milestone],
    });
    await sleep(WRITE_DELAY_MS);
  }

  if (!DRY) writeFileSync(MAP_FILE, `${JSON.stringify(sortKeys(map), null, 2)}\n`);
  console.log('Done.');
}

function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
