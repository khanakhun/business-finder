// pnpm site-schema:catalog [--check] — writes generated/catalog/*.md from the block catalog (BF-033).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { catalogFiles } from '../catalog/render-markdown.ts';

const dir = fileURLToPath(new URL('../../generated/catalog/', import.meta.url));
const check = process.argv.includes('--check');
mkdirSync(dir, { recursive: true });
let stale = 0;
for (const [file, content] of catalogFiles()) {
  let current = '';
  try {
    current = readFileSync(`${dir}${file}`, 'utf8');
  } catch {
    // Not generated yet.
  }
  if (current === content) continue;
  stale += 1;
  if (check) console.error(`catalog/${file} is out of date. Run: pnpm site-schema:catalog`);
  else writeFileSync(`${dir}${file}`, content);
}
console.log(
  check ? `Block catalog ${stale === 0 ? 'up to date' : 'stale'}.` : `Wrote ${stale} catalog file(s).`,
);
process.exit(check && stale > 0 ? 1 : 0);
