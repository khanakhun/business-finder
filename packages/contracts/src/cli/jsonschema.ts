// pnpm contracts:jsonschema [--check] — writes generated/jsonschema/<target>/<Id>.json for every opted-in schema
// plus generated/error-codes.json (the error registry, for non-TypeScript services), and removes stale files.
// --check exits 1 instead of writing when the committed files are out of date.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES, ERROR_TYPE_BASE } from '../errors.ts';
import { buildJsonSchemas, EXPORT_TARGETS, sortKeys } from '../registry.ts';

const OUT_DIR = fileURLToPath(new URL('../../generated', import.meta.url));

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Expected files (path relative to generated/ → content). */
export function expectedFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const target of EXPORT_TARGETS) {
    for (const [id, schema] of Object.entries(buildJsonSchemas(target))) {
      files.set(join('jsonschema', target, `${id}.json`), json(schema));
    }
  }
  files.set('error-codes.json', json(sortKeys({ typeBase: ERROR_TYPE_BASE, codes: ERROR_CODES })));
  return files;
}

function existingFiles(dir = OUT_DIR, prefix = ''): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) for (const [k, v] of existingFiles(join(dir, entry.name), path)) files.set(k, v);
    else files.set(path, readFileSync(join(dir, entry.name), 'utf8'));
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
      console.log(`Generated contracts up to date (${expected.size} files).`);
      return 0;
    }
    console.error(
      `Generated contracts out of date: ${[...changed, ...stale].join(', ')}. Run: pnpm contracts:jsonschema`,
    );
    return 1;
  }
  for (const file of stale) rmSync(join(OUT_DIR, file));
  for (const [file, content] of expected) {
    mkdirSync(join(OUT_DIR, file, '..'), { recursive: true });
    writeFileSync(join(OUT_DIR, file), content);
  }
  console.log(
    `Wrote ${expected.size} generated file(s) to ${OUT_DIR} (${changed.length} changed, ${stale.length} removed).`,
  );
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.includes('--check'));
