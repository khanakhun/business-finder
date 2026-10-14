// pnpm contracts:jsonschema [--check] — writes generated/jsonschema/<target>/<Id>.json for every opted-in schema
// and removes stale files. --check exits 1 instead of writing when the committed files are out of date.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildJsonSchemas, EXPORT_TARGETS } from '../registry.ts';

const OUT_DIR = fileURLToPath(new URL('../../generated/jsonschema', import.meta.url));

/** Expected files (relative path → content) for every target. */
export function expectedFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const target of EXPORT_TARGETS) {
    for (const [id, schema] of Object.entries(buildJsonSchemas(target))) {
      files.set(join(target, `${id}.json`), `${JSON.stringify(schema, null, 2)}\n`);
    }
  }
  return files;
}

function existingFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const target of existsSync(OUT_DIR) ? readdirSync(OUT_DIR) : []) {
    for (const file of readdirSync(join(OUT_DIR, target))) {
      files.set(join(target, file), readFileSync(join(OUT_DIR, target, file), 'utf8'));
    }
  }
  return files;
}

function main(check: boolean): number {
  const expected = expectedFiles();
  const existing = existingFiles();
  const stale = [...existing.keys()].filter((f) => !expected.has(f));
  const changed = [...expected].filter(([f, content]) => existing.get(f) !== content).map(([f]) => f);
  if (check) {
    if (stale.length + changed.length === 0) {
      console.log(`JSON Schemas up to date (${expected.size} files).`);
      return 0;
    }
    console.error(
      `JSON Schemas out of date: ${[...changed, ...stale].join(', ')}. Run: pnpm contracts:jsonschema`,
    );
    return 1;
  }
  for (const file of stale) rmSync(join(OUT_DIR, file));
  for (const [file, content] of expected) {
    mkdirSync(join(OUT_DIR, file, '..'), { recursive: true });
    writeFileSync(join(OUT_DIR, file), content);
  }
  console.log(
    `Wrote ${expected.size} JSON Schema file(s) to ${OUT_DIR} (${changed.length} changed, ${stale.length} removed).`,
  );
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.includes('--check'));
