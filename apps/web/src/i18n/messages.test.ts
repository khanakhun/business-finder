import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import en from './messages/en.json';
import fr from './messages/fr.json';

const flatten = (value: unknown, prefix = ''): Record<string, string> =>
  typeof value === 'string'
    ? { [prefix]: value }
    : Object.assign(
        {},
        ...Object.entries(value as object).map(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k)),
      );

describe('messages', () => {
  it('EN and FR have exactly the same keys and no empty strings', () => {
    const enKeys = flatten(en);
    const frKeys = flatten(fr);
    expect(Object.keys(frKeys).sort()).toEqual(Object.keys(enKeys).sort());
    for (const [key, text] of [...Object.entries(enKeys), ...Object.entries(frKeys)])
      expect(text.trim(), key).not.toBe('');
  });

  it('keeps the same ICU placeholders in both languages', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const enKeys = flatten(en);
    const frKeys = flatten(fr);
    for (const key of Object.keys(enKeys))
      expect(placeholders(frKeys[key] ?? ''), key).toEqual(placeholders(enKeys[key] ?? ''));
  });
});

/** Files under src/app and src/components, excluding tests. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

describe('user-facing strings', () => {
  // The ticket's guard: copy in JSX must come from next-intl. Parsing with TypeScript (not a regex) means only real
  // JSX text nodes count — generics like Promise<void> or ternaries between tags cannot cause false positives.
  const ALLOWED = new Set(['/']);
  it('are never hard-coded in JSX text', () => {
    const root = join(import.meta.dirname, '..');
    const offenders: string[] = [];
    for (const file of [...sources(join(root, 'app')), ...sources(join(root, 'components'))]) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isJsxText(node)) {
          const text = node.text.trim();
          if (/[A-Za-zÀ-ÿ]/.test(text) && !ALLOWED.has(text)) offenders.push(`${file}: "${text}"`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(offenders).toEqual([]);
  });
});
