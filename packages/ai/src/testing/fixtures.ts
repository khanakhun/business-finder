import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256, stableStringify } from '../cache.ts';

/** A recorded model answer for one (task, prompt version, input). */
export interface Fixture {
  readonly task: string;
  readonly promptVersion: number;
  readonly input: unknown;
  readonly output: unknown;
}

export const fixtureKey = (task: string, promptVersion: number, input: unknown): string =>
  sha256(stableStringify({ task, promptVersion, input })).slice(0, 24);

export const fixturePath = (dir: string, task: string, promptVersion: number, input: unknown): string =>
  join(dir, task, `v${promptVersion}`, `${fixtureKey(task, promptVersion, input)}.json`);

export function readFixture(path: string): Fixture | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Fixture) : undefined;
}

export function writeFixture(path: string, fixture: Fixture): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
}
