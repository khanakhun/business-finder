#!/usr/bin/env node
// pnpm gen:module <context> — scaffold a hexagonal module in apps/api like the `system` reference module.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateModule } from './generate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const context = process.argv[2];
if (!context) {
  console.error('Usage: pnpm gen:module <context-in-kebab-case>');
  process.exit(1);
}
try {
  const touched = generateModule(ROOT, context);
  spawnSync('pnpm', ['exec', 'biome', 'check', '--write', ...touched], { cwd: ROOT, stdio: 'ignore' });
  console.log(`Generated module "${context}":`);
  for (const path of touched) console.log(`  ${path}`);
  console.log(
    '\nNext: define the table (packages/db), implement the repository, add permissions (BF-010), then pnpm api:openapi.',
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
