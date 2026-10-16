import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { outputSchemaFiles } from './output.ts';

// Writes (or with --check, verifies) schemas/cli-output/*.schema.json.

const dir = new URL('../../schemas/cli-output/', import.meta.url);
const check = process.argv.includes('--check');
let stale = 0;
mkdirSync(dir, { recursive: true });
for (const [name, body] of outputSchemaFiles()) {
  const file = new URL(name, dir);
  const current = (() => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  })();
  if (current === body) continue;
  if (check) {
    stale++;
    console.error(`stale: schemas/cli-output/${name}`);
  } else writeFileSync(file, body);
}
if (stale) {
  console.error('Run `pnpm --filter @bf/sitekit schemas` and commit the result.');
  process.exit(1);
}
