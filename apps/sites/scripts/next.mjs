#!/usr/bin/env node
// Runs the Next.js CLI with the validated environment from @bf/config (.env, .env.generated, real env), so the
// renderer uses the same ports and database as `pnpm infra:up` without its own .env file.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadEnvOrExit, readRawEnv, sitesEnv } from '@bf/config';

const [command = 'dev', ...rest] = process.argv.slice(2);
const env = loadEnvOrExit(sitesEnv, { label: 'sites' });
const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');
const args = [command, ...(command === 'build' ? [] : ['--port', String(env.SITES_PORT)]), ...rest];
// The app parses process.env itself (it reads no file): hand it the repo's .env values (real env wins).
const raw = Object.fromEntries(Object.entries(readRawEnv()).filter(([, value]) => value !== undefined));
const child = spawn(process.execPath, [nextBin, ...args], {
  stdio: 'inherit',
  env: { ...raw, ...process.env },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 1));
