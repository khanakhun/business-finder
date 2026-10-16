// pnpm site-schema:jsonschema [--check] — writes generated/*.schema.json from the SiteSpec schema (BF-033).
// --check exits 1 instead of writing when the committed files are out of date.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { jsonSchemaFiles } from '../json-schema.ts';

const dir = fileURLToPath(new URL('../../generated/', import.meta.url));
const check = process.argv.includes('--check');
let stale = 0;
for (const [file, content] of jsonSchemaFiles()) {
  const path = `${dir}${file}`;
  let current = '';
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    // Not generated yet.
  }
  if (current === content) continue;
  stale += 1;
  if (check) console.error(`${file} is out of date. Run: pnpm site-schema:jsonschema`);
  else writeFileSync(path, content);
}
console.log(
  check ? `Site schemas ${stale === 0 ? 'up to date' : 'stale'}.` : `Wrote ${stale} site schema file(s).`,
);
process.exit(check && stale > 0 ? 1 : 0);
