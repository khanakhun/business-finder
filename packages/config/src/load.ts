import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import type { z } from 'zod';
import { describeVariables, type EnvSchema, type VariableInfo } from './schema.ts';

export const DEFAULT_ENV_FILES = ['.env', '.env.generated'] as const;

export interface LoadEnvOptions {
  /** Dotenv files relative to `root`, lowest precedence first. Missing files are skipped. */
  readonly files?: readonly string[];
  /** Directory the files are resolved against. Defaults to the repository root above `process.cwd()`. */
  readonly root?: string;
  /** The real environment; it always wins over files. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Name shown in reports, e.g. `api`. */
  readonly label?: string;
}

export interface EnvProblem {
  readonly variable: VariableInfo;
  readonly kind: 'missing' | 'invalid';
  readonly message: string;
}

/** Thrown when the environment does not satisfy a schema. `report` is safe to print (no values). */
export class EnvValidationError extends Error {
  readonly problems: readonly EnvProblem[];
  readonly report: string;

  constructor(label: string, problems: readonly EnvProblem[]) {
    const report = formatReport(label, problems);
    super(report);
    this.name = 'EnvValidationError';
    this.problems = problems;
    this.report = report;
  }
}

/**
 * Loads dotenv files and the real environment, validates them against `schema` and returns a frozen,
 * typed object. Precedence: real environment > `.env.generated` > `.env` > schema defaults.
 *
 * @throws EnvValidationError listing every missing or invalid variable, without printing values.
 */
export function loadEnv<S extends EnvSchema>(schema: S, options: LoadEnvOptions = {}): Readonly<z.output<S>> {
  const raw = readRawEnv(options);
  const result = schema.safeParse(raw);
  if (result.success) return Object.freeze(result.data);

  const variables = new Map(describeVariables(schema).map((v) => [v.name, v]));
  const problems: EnvProblem[] = [];
  for (const issue of result.error.issues) {
    const name = String(issue.path[0] ?? '');
    const variable = variables.get(name);
    if (!variable) continue;
    const isMissing = raw[name] === undefined || raw[name] === '';
    problems.push({ variable, kind: isMissing ? 'missing' : 'invalid', message: issue.message });
  }
  throw new EnvValidationError(options.label ?? 'app', problems);
}

/** `loadEnv` for app entry points: prints the report and exits with code 1 on invalid configuration. */
export function loadEnvOrExit<S extends EnvSchema>(
  schema: S,
  options: LoadEnvOptions = {},
  exit: (code: number) => never = process.exit,
): Readonly<z.output<S>> {
  try {
    return loadEnv(schema, options);
  } catch (error) {
    if (!(error instanceof EnvValidationError)) throw error;
    console.error(error.report);
    return exit(1);
  }
}

/** Merged raw variables: files in order, then the real environment. Empty strings count as unset. */
export function readRawEnv(options: LoadEnvOptions = {}): Record<string, string | undefined> {
  const root = options.root ?? findRepoRoot(process.cwd());
  const merged: Record<string, string | undefined> = {};
  for (const file of options.files ?? DEFAULT_ENV_FILES) {
    const path = join(root, file);
    if (existsSync(path)) Object.assign(merged, parseEnv(readFileSync(path, 'utf8')));
  }
  for (const [key, value] of Object.entries(options.env ?? process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  for (const [key, value] of Object.entries(merged)) {
    // `FOO=` in a file means "not set", so schema defaults and required checks apply.
    if (value === '') merged[key] = undefined;
  }
  return merged;
}

/** Nearest ancestor containing `pnpm-workspace.yaml`, or `start` itself if there is none. */
export function findRepoRoot(start: string): string {
  let dir = resolve(start);
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
  return dir;
}

/** Human-readable report grouped by problem kind. Never includes values. */
export function formatReport(label: string, problems: readonly EnvProblem[]): string {
  const lines = [`Invalid environment for ${label}: ${problems.length} problem(s).`];
  for (const kind of ['missing', 'invalid'] as const) {
    const group = problems.filter((p) => p.kind === kind);
    if (group.length === 0) continue;
    lines.push('', kind === 'missing' ? 'Missing (required, no default):' : 'Invalid:');
    for (const { variable, message } of group) {
      const tag = variable.secret ? ' [secret]' : '';
      const detail = kind === 'invalid' ? ` — ${message}` : '';
      lines.push(`  ${variable.name}${tag}${detail}`);
      if (variable.description) lines.push(`      ${variable.description}`);
    }
  }
  lines.push('', 'Set them in .env (see .env.example and docs/ENVIRONMENT.md), then retry.');
  return lines.join('\n');
}

/** Copy of `values` with secret variables replaced, for logging a loaded config. */
export function redact(
  schema: EnvSchema,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const secretNames = new Set(
    describeVariables(schema)
      .filter((v) => v.secret)
      .map((v) => v.name),
  );
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      secretNames.has(key) && value !== undefined ? '[redacted]' : value,
    ]),
  );
}
