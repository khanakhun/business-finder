import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot } from '../load.ts';
import { checkApps } from './check.ts';
import { collectVariables, renderDocTable, renderEnvExample, updateDoc } from './render.ts';

const FAKE_SECRET = 'fake-secret-for-check-output-0123456789abcdef';

describe('checkApps', () => {
  it('reports invalid apps without printing secret values', () => {
    const { output, ok } = checkApps(['api'], { BETTER_AUTH_SECRET: FAKE_SECRET, LOG_LEVEL: 'debug' });
    expect(ok).toBe(false);
    expect(output).toContain('BETTER_AUTH_SECRET');
    expect(output).toContain('(set, hidden)');
    expect(output).toContain('LOG_LEVEL                      debug');
    expect(output).toContain('Missing (required, no default):');
    expect(output).not.toContain(FAKE_SECRET);
  });

  it('passes a valid web environment', () => {
    const { output, ok } = checkApps(['web'], {});
    expect(ok).toBe(true);
    expect(output).toContain('✔ web: valid');
    expect(output).toContain('(default) 3000');
  });
});

describe('generated docs', () => {
  const variables = collectVariables();

  it('lists each variable once, with the apps that use it', () => {
    const names = variables.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    expect(variables.find((v) => v.name === 'DATABASE_URL')?.apps).toEqual(['api', 'worker']);
    expect(variables.find((v) => v.name === 'NODE_ENV')?.apps).toEqual([
      'api',
      'worker',
      'web',
      'sites',
      'intel',
    ]);
  });

  it('renders a table row per variable and never a secret default', () => {
    const table = renderDocTable(variables);
    for (const v of variables) expect(table).toContain(`| \`${v.name}\` |`);
    expect(variables.filter((v) => v.secret && v.defaultValue !== undefined)).toEqual([]);
  });

  it('replaces only the generated block of the document', () => {
    const doc = updateDoc('# Title\n\nintro\n', 'TABLE-1');
    expect(doc).toBe('# Title\n\nintro\n\nTABLE-1\n');
    const table = renderDocTable(variables);
    const once = updateDoc('# Title\n', table);
    expect(updateDoc(`${once}\n## After\n`, table)).toBe(`${once}\n## After\n`);
  });

  it('writes .env.example with empty values for required inputs and commented defaults', () => {
    const example = renderEnvExample(variables);
    expect(example).toMatch(/^BETTER_AUTH_SECRET=$/m);
    expect(example).toMatch(/^# LOG_LEVEL=info$/m);
    expect(example).toMatch(/^# DATABASE_URL= {3}# written by pnpm infra:up$/m);
    expect(example).toMatch(/^# --- Feature flags ---$/m);
    // Only required, non-generated variables are uncommented, and they are always empty.
    for (const line of example.split('\n').filter((l) => /^[A-Z_]+=/.test(l))) expect(line).toMatch(/=$/);
  });
});

describe('committed generated files', () => {
  const root = findRepoRoot(import.meta.dirname);

  it('docs/ENVIRONMENT.md is up to date (run `pnpm env:doc`)', () => {
    const current = readFileSync(join(root, 'docs/ENVIRONMENT.md'), 'utf8');
    expect(updateDoc(current, renderDocTable(collectVariables()))).toBe(current);
  });

  it('.env.example is up to date (run `pnpm env:example`)', () => {
    expect(readFileSync(join(root, '.env.example'), 'utf8')).toBe(renderEnvExample(collectVariables()));
  });
});
