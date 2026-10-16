import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { EnvValidationError, findRepoRoot, loadEnv, loadEnvOrExit, readRawEnv, redact } from './load.ts';
import { booleanFlag, secret } from './schema.ts';

const FAKE_SECRET = 'fake-secret-value-that-must-never-be-printed-0123456789';

const schema = z.object({
  DATABASE_URL: secret(z.url({ protocol: /^postgres$/ }).describe('Primary database.')),
  API_TOKEN: secret(z.string().min(80).describe('Token for the thing.')),
  APP_URL: z.url().default('http://localhost:3000').describe('Dashboard URL.'),
  REQUIRED_NAME: z.string().min(1).describe('Something required.'),
  FLAG: booleanFlag(false).describe('A flag.'),
});

function loadWith(env: Record<string, string>) {
  return loadEnv(schema, { env, files: [], label: 'test' });
}

function errorFrom(fn: () => unknown): EnvValidationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('expected EnvValidationError');
}

const VALID = { DATABASE_URL: 'postgres://u:p@h:5432/d', API_TOKEN: 'x'.repeat(80), REQUIRED_NAME: 'n' };

describe('loadEnv', () => {
  it('returns typed, frozen values with defaults applied', () => {
    const env = loadWith(VALID);
    expect(env.APP_URL).toBe('http://localhost:3000');
    expect(env.FLAG).toBe(false);
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('drops variables the schema does not declare', () => {
    expect(loadWith({ ...VALID, UNRELATED: 'x' })).not.toHaveProperty('UNRELATED');
  });

  it('lists every missing required variable with its description', () => {
    const error = errorFrom(() => loadWith({ API_TOKEN: 'x'.repeat(80) }));
    expect(error.problems.map((p) => [p.variable.name, p.kind])).toEqual([
      ['DATABASE_URL', 'missing'],
      ['REQUIRED_NAME', 'missing'],
    ]);
    expect(error.report).toContain('Missing (required, no default):');
    expect(error.report).toContain('REQUIRED_NAME');
    expect(error.report).toContain('Something required.');
  });

  it('treats an empty string as unset', () => {
    const error = errorFrom(() => loadWith({ ...VALID, REQUIRED_NAME: '' }));
    expect(error.problems).toMatchObject([{ variable: { name: 'REQUIRED_NAME' }, kind: 'missing' }]);
  });

  it('reports an invalid URL', () => {
    const error = errorFrom(() => loadWith({ ...VALID, APP_URL: 'not a url' }));
    expect(error.problems).toMatchObject([{ variable: { name: 'APP_URL' }, kind: 'invalid' }]);
    expect(error.report).toMatch(/Invalid:\n {2}APP_URL — /);
  });

  it('never prints secret values, even when they are invalid', () => {
    const error = errorFrom(() =>
      loadWith({ DATABASE_URL: `http://${FAKE_SECRET}@h/d`, API_TOKEN: FAKE_SECRET, REQUIRED_NAME: 'n' }),
    );
    expect(error.problems.map((p) => p.variable.name)).toEqual(['DATABASE_URL', 'API_TOKEN']);
    expect(error.report).toContain('API_TOKEN [secret]');
    expect(error.report).not.toContain(FAKE_SECRET);
    expect(error.message).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(error.problems)).not.toContain(FAKE_SECRET);
  });

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
  ])('parses boolean %s strictly', (raw, expected) => {
    expect(loadWith({ ...VALID, FLAG: raw }).FLAG).toBe(expected);
  });

  it.each(['yes', 'TRUE', 'on', ' 1'])('rejects boolean %j', (raw) => {
    expect(errorFrom(() => loadWith({ ...VALID, FLAG: raw })).problems).toMatchObject([
      { variable: { name: 'FLAG' }, kind: 'invalid' },
    ]);
  });
});

describe('precedence', () => {
  const root = mkdtempSync(join(tmpdir(), 'bf-config-'));
  writeFileSync(join(root, '.env'), 'A=from-env\nB=from-env\nC=from-env\nE=\n');
  writeFileSync(join(root, '.env.generated'), 'B=from-generated\nC=from-generated\n');

  it('real environment > .env.generated > .env', () => {
    const raw = readRawEnv({ root, env: { C: 'from-real' } });
    expect(raw).toMatchObject({ A: 'from-env', B: 'from-generated', C: 'from-real' });
  });

  it('falls back to schema defaults when nothing sets a variable', () => {
    const s = z.object({ D: z.string().default('from-default'), E: z.string().default('empty-means-unset') });
    expect(loadEnv(s, { root, env: {} })).toEqual({ D: 'from-default', E: 'empty-means-unset' });
  });

  it('skips missing files', () => {
    expect(readRawEnv({ root, env: {}, files: ['.env.nope'] })).toEqual({});
  });
});

describe('loadEnvOrExit', () => {
  it('prints the report and exits with code 1', () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });
    expect(() =>
      loadEnvOrExit(schema, { env: { API_TOKEN: FAKE_SECRET }, files: [], label: 'api' }, exit),
    ).toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
    const printed = errorLog.mock.calls.flat().join('\n');
    expect(printed).toContain('Invalid environment for api');
    expect(printed).not.toContain(FAKE_SECRET);
    errorLog.mockRestore();
  });

  it('returns the env when valid', () => {
    expect(loadEnvOrExit(schema, { env: VALID, files: [] }).REQUIRED_NAME).toBe('n');
  });

  it('rethrows unexpected errors', () => {
    const broken = z.object({}).transform(() => {
      throw new TypeError('boom');
    });
    // biome-ignore lint/suspicious/noExplicitAny: deliberately passing a non-object schema to hit the rethrow path
    expect(() => loadEnvOrExit(broken as any, { env: {}, files: [] })).toThrow('boom');
  });
});

describe('redact', () => {
  it('hides secret values only', () => {
    expect(redact(schema, { API_TOKEN: FAKE_SECRET, APP_URL: 'http://x', DATABASE_URL: undefined })).toEqual({
      API_TOKEN: '[redacted]',
      APP_URL: 'http://x',
      DATABASE_URL: undefined,
    });
  });
});

describe('findRepoRoot', () => {
  it('finds the workspace root from a nested directory', () => {
    // packages/config/src → repo root; not the folder name, which depends on where the repo is cloned.
    expect(findRepoRoot(import.meta.dirname)).toBe(resolve(import.meta.dirname, '../../..'));
  });

  it('returns the start directory when there is no workspace above it', () => {
    expect(findRepoRoot(tmpdir())).toBe(tmpdir());
  });
});
