// pnpm site-schema:catalog [--check] — writes generated/catalog/*.md from the block catalog (BF-033), with an example
// of each block from the fixture sites; removes stale files. --check exits 1 when the committed files differ.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { catalogFiles, examplesFrom } from '../catalog/render-markdown.ts';
import { SiteSpecSchema } from '../spec/site.ts';

const root = new URL('../../', import.meta.url);
const dir = fileURLToPath(new URL('generated/catalog/', root));
const check = process.argv.includes('--check');
const sites = ['salon-gustavia', 'cafe-saint-jean', 'hardware-store-lorient', 'villa-agency'].map((name) =>
  SiteSpecSchema.parse(JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, root), 'utf8'))),
);
const expected = catalogFiles(examplesFrom(sites));
const listed = (): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
// --check never writes.
if (!check) mkdirSync(dir, { recursive: true });
const existing = listed().filter((file) => file.endsWith('.md'));
const stale = existing.filter((file) => !expected.has(file));
const changed = [...expected].filter(([file, content]) => {
  try {
    return readFileSync(`${dir}${file}`, 'utf8') !== content;
  } catch {
    return true;
  }
});
if (check) {
  const wrong = [...changed.map(([file]) => file), ...stale];
  if (wrong.length > 0)
    console.error(
      `Out of date: ${wrong.map((f) => `catalog/${f}`).join(', ')}. Run: pnpm site-schema:catalog`,
    );
  console.log(`Block catalog ${wrong.length === 0 ? 'up to date' : 'stale'}.`);
  process.exit(wrong.length === 0 ? 0 : 1);
}
for (const file of stale) rmSync(`${dir}${file}`);
for (const [file, content] of changed) writeFileSync(`${dir}${file}`, content);
console.log(`Wrote ${changed.length} catalog file(s), removed ${stale.length}.`);
