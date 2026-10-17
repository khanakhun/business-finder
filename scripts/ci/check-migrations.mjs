#!/usr/bin/env node
// Expand/contract guard for migrations (BF-061, docs/runbooks/deploy.md). Deploys run the migrations first, while the
// previous release is still serving — and a rollback runs the previous release on the migrated schema. So a migration
// may add, never take away from what running code uses: dropping or renaming a column or table, changing a column's
// type, or making a column NOT NULL breaks the release before it.
//
// Such a change belongs in a later "contract" release, once no deployed code uses the old shape, and its file says so
// with a line `-- bf:contract <why it is safe now>` (reviewed like any other code). This script fails on a
// destructive statement in a migration file without that line.
//   node scripts/ci/check-migrations.mjs [<migrations dir>]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'packages/db/migrations';
const RULES = [
  { name: 'drops a column', re: /\bDROP\s+COLUMN\b/i },
  { name: 'drops a table', re: /\bDROP\s+TABLE\b/i },
  { name: 'renames', re: /\bALTER\s+(TABLE|VIEW|INDEX|SEQUENCE)\b[^;]*\bRENAME\b/i },
  { name: 'changes a column type', re: /\bALTER\s+COLUMN\b[^;]*\b(SET\s+DATA\s+)?TYPE\b/i },
  { name: 'makes a column NOT NULL', re: /\bALTER\s+COLUMN\b[^;]*\bSET\s+NOT\s+NULL\b/i },
  // The previous release inserts rows without the new column: it needs a default (or must be nullable).
  {
    name: 'adds a NOT NULL column without a default',
    re: /\bADD\s+COLUMN\b(?![^;]*\bDEFAULT\b)[^;]*\bNOT\s+NULL\b/i,
  },
];
const CONTRACT = /^\s*--\s*bf:contract\s+\S/m;

// Statements without comments (a commented-out DROP is not a drop).
const statements = (sql) =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .split(/;|--> statement-breakpoint/)
    .map((statement) => statement.trim())
    .filter(Boolean);

let failures = 0;
for (const file of readdirSync(dir)
  .filter((name) => name.endsWith('.sql'))
  .sort()) {
  const sql = readFileSync(join(dir, file), 'utf8');
  if (CONTRACT.test(sql)) continue;
  for (const statement of statements(sql)) {
    for (const rule of RULES) {
      if (rule.re.test(statement)) {
        failures++;
        console.error(`${file}: ${rule.name} — ${statement.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
  }
}
if (failures > 0) {
  console.error(
    `\n${failures} destructive change(s). Split them: expand now, contract in a later release with a ` +
      '`-- bf:contract <why it is safe now>` line (docs/runbooks/deploy.md).',
  );
  process.exit(1);
}
console.log('Migrations are expand-only (or marked bf:contract).');
