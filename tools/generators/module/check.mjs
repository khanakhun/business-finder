#!/usr/bin/env node
// pnpm gen:module:check — proves the templates compile, lint and pass their tests: generates a throwaway module
// into the real app, runs typecheck + lint + its unit tests, then restores every touched file.
// Not part of `pnpm verify` (it edits the working tree); CI runs it as its own step (BF-009).
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateModule } from './generate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CONTEXT = 'gen-check';
const restore = new Map(
  ['packages/contracts/src/index.ts', 'apps/api/src/app.module.ts'].map((p) => [
    p,
    readFileSync(join(ROOT, p), 'utf8'),
  ]),
);

const run = (cmd, args, cwd = ROOT) => {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
};

let status = 0;
try {
  const touched = generateModule(ROOT, CONTEXT);
  run('pnpm', ['exec', 'biome', 'check', '--write', ...touched]);
  run('pnpm', ['exec', 'biome', 'check', ...touched]);
  run('pnpm', ['exec', 'tsc', '--noEmit'], join(ROOT, 'apps/api'));
  run('pnpm', ['exec', 'tsc', '--noEmit'], join(ROOT, 'packages/contracts'));
  run('pnpm', ['exec', 'vitest', 'run', `src/modules/${CONTEXT}`], join(ROOT, 'apps/api'));
  console.log('\ngen:module check passed.');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  status = 1;
} finally {
  rmSync(join(ROOT, 'apps/api/src/modules', CONTEXT), { recursive: true, force: true });
  rmSync(join(ROOT, 'packages/contracts/src', `${CONTEXT}.ts`), { force: true });
  for (const [path, content] of restore) writeFileSync(join(ROOT, path), content);
}
process.exit(status);
