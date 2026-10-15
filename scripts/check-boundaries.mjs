#!/usr/bin/env node
// pnpm check:boundaries — enforces the dependency rules of AGENTS.md §3 on every import in apps/* and packages/*.
// Prints `file:line  [rule] message` per violation and exits 1 if there are any. CI runs it as the `boundaries` job.
//
// Imports are found with TypeScript's pre-processor (import/export-from, require, dynamic import, triple-slash
// references), so comments and strings never count. Relative imports are resolved to the workspace they land in.
import { globSync, readFileSync } from 'node:fs';
import { dirname, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SOURCE_GLOBS = [
  'apps/*/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
  'packages/*/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
];
const IGNORED_DIRS = ['node_modules', 'dist', 'build', '.next', '.turbo', 'coverage', 'out', '.drift-check'];

/** Libraries that make code framework-, database- or network-bound (domain code must stay pure). */
const INFRASTRUCTURE_MODULES = [
  '@nestjs/*',
  'drizzle-orm',
  'drizzle-orm/*',
  'postgres',
  'pg',
  'ioredis',
  'bullmq',
  '@bf/db',
  '@bf/db/*',
  '@bf/queue',
  '@bf/queue/*',
  '@bf/observability',
  '@bf/observability/*',
  'express',
  'fastify',
  'undici',
  'axios',
  'node:http',
  'node:https',
  'node:net',
  'http',
  'https',
  '@opentelemetry/*',
];

/**
 * The rule table. `from` selects importing files (repo-relative globs); each `disallow` entry matches the import:
 * - `workspace`: a glob over the target workspace directory (`apps/web`), reached by package name or relative path;
 *   `exceptSelf` allows the importing file's own workspace.
 * - `modules`: globs over bare module specifiers (`@nestjs/*`, `drizzle-orm`).
 * - `relativeInto`: directory names a relative import must not resolve into, relative to the importing layer's
 *   parent (e.g. a `domain/` file reaching `../infrastructure/`).
 */
export const RULES = [
  {
    id: 'app-to-app',
    from: ['apps/*/**'],
    disallow: [{ workspace: 'apps/*', exceptSelf: true }],
    message: 'Apps must not import from other apps; move shared code to a package in packages/.',
  },
  {
    id: 'package-to-app',
    from: ['packages/*/**'],
    disallow: [{ workspace: 'apps/*' }],
    message: 'Packages must not import from apps.',
  },
  {
    id: 'contracts-leaf',
    // Source only: tool configs (vitest.config.ts) may use shared dev tooling.
    from: ['packages/contracts/src/**'],
    disallow: [{ workspace: 'packages/*', exceptSelf: true }],
    message: '@bf/contracts is the leaf: it imports no other internal package.',
  },
  {
    id: 'pure-domain',
    from: ['apps/*/src/modules/*/domain/**', 'packages/*/src/**/domain/**'],
    disallow: [
      { modules: INFRASTRUCTURE_MODULES },
      { relativeInto: ['application', 'infrastructure', 'interface'] },
    ],
    message: 'Domain code imports no framework, database, HTTP or outer layer (ports & adapters).',
  },
  {
    id: 'web-no-server-packages',
    from: ['apps/web/**'],
    // `@bf/auth` itself is server configuration (it pulls in @bf/db); the dashboard uses `@bf/auth/client`.
    disallow: [
      { modules: ['@bf/db', '@bf/db/*', '@bf/queue', '@bf/queue/*', '@bf/ai', '@bf/ai/*', '@bf/auth'] },
    ],
    message: 'The dashboard is a client of the API: no database, queue, LLM or server auth packages.',
  },
];

/** Package name → workspace directory (`@bf/web` → `apps/web`) for every apps/* and packages/* workspace. */
export function readWorkspaces(root) {
  const workspaces = new Map();
  for (const manifest of globSync(['apps/*/package.json', 'packages/*/package.json'], { cwd: root })) {
    const { name } = JSON.parse(readFileSync(join(root, manifest), 'utf8'));
    if (name) workspaces.set(name, toPosix(dirname(manifest)));
  }
  return workspaces;
}

/** Bare package name of a specifier: `@bf/ui/components/x` → `@bf/ui`, `lodash/fp` → `lodash`. */
function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const toPosix = (path) => path.split(sep).join('/');
const workspaceOf = (path) => path.match(/^(apps|packages)\/[^/]+/)?.[0];

/** Every import of one file: `{ specifier, line, target }` where target is a resolved workspace or a module. */
export function importsOf(root, file, source, workspaces) {
  const info = ts.preProcessFile(source, true, true);
  const lineOf = (pos) => source.slice(0, pos).split('\n').length;
  const entries = [...info.importedFiles, ...info.referencedFiles];
  return entries.map(({ fileName: specifier, pos }) => {
    let workspace;
    let resolvedPath;
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      resolvedPath = toPosix(relative(root, resolve(root, dirname(file), specifier)));
      workspace = workspaceOf(resolvedPath);
    } else {
      workspace = workspaces.get(packageName(specifier));
    }
    return { specifier, line: lineOf(pos), workspace, resolvedPath };
  });
}

function violates(entry, file, imp) {
  if (entry.workspace) {
    if (!imp.workspace || !matchesGlob(imp.workspace, entry.workspace)) return false;
    return !(entry.exceptSelf && imp.workspace === workspaceOf(file));
  }
  if (entry.modules) {
    if (imp.resolvedPath) return false;
    return entry.modules.some((glob) => imp.specifier === glob || matchesGlob(imp.specifier, glob));
  }
  if (entry.relativeInto && imp.resolvedPath) {
    // The layer directory containing the file (…/domain) and its parent (…/<module>).
    const layer = file.match(/^(.*\/)domain(\/|$)/);
    if (!layer) return false;
    return entry.relativeInto.some((dir) => imp.resolvedPath.startsWith(`${layer[1]}${dir}/`));
  }
  return false;
}

/** All violations under `root`, sorted by file and line. */
export function checkBoundaries(root, rules = RULES) {
  const workspaces = readWorkspaces(root);
  const files = globSync(SOURCE_GLOBS, {
    cwd: root,
    exclude: (path) => IGNORED_DIRS.some((dir) => toPosix(path).split('/').includes(dir)),
  })
    .map(toPosix)
    .sort();
  const violations = [];
  for (const file of files) {
    const applicable = rules.filter((rule) => rule.from.some((glob) => matchesGlob(file, glob)));
    if (applicable.length === 0) continue;
    const imports = importsOf(root, file, readFileSync(join(root, file), 'utf8'), workspaces);
    for (const imp of imports) {
      for (const rule of applicable) {
        if (rule.disallow.some((entry) => violates(entry, file, imp))) {
          violations.push({
            file,
            line: imp.line,
            rule: rule.id,
            specifier: imp.specifier,
            message: rule.message,
          });
        }
      }
    }
  }
  return { files: files.length, violations };
}

export function format({ file, line, rule, specifier, message }) {
  return `${file}:${line}  [${rule}] import '${specifier}' — ${message}`;
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { files, violations } = checkBoundaries(root);
  for (const violation of violations) console.error(format(violation));
  if (violations.length > 0) {
    console.error(`\n${violations.length} boundary violation(s) in ${files} files. Rules: AGENTS.md §3.`);
    process.exitCode = 1;
  } else {
    console.log(`Module boundaries OK (${files} files, ${RULES.length} rules).`);
  }
}
