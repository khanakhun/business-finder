// pnpm env:doc / pnpm env:example — regenerate docs/ENVIRONMENT.md (table block) and .env.example from the
// schemas. With --check, exit 1 instead of writing when a file is out of date (CI).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../load.ts';
import { collectVariables, renderDocTable, renderEnvExample, updateDoc } from './render.ts';

type Target = 'doc' | 'example';

function render(target: Target, current: string): string {
  const variables = collectVariables();
  return target === 'doc' ? updateDoc(current, renderDocTable(variables)) : renderEnvExample(variables);
}

function main(args: readonly string[]): number {
  const target = args[0];
  if (target !== 'doc' && target !== 'example') {
    console.error('Usage: generate.ts doc|example [--check]');
    return 1;
  }
  const root = findRepoRoot(process.cwd());
  const file = join(root, target === 'doc' ? 'docs/ENVIRONMENT.md' : '.env.example');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const next = render(target, current);
  if (args.includes('--check')) {
    if (next !== current) {
      console.error(`${file} is out of date. Run: pnpm env:${target}`);
      return 1;
    }
    console.log(`${file} is up to date.`);
    return 0;
  }
  writeFileSync(file, next);
  console.log(`Wrote ${file}`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
