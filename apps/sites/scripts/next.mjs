#!/usr/bin/env node
// Runs the Next.js CLI with the validated environment from @bf/config (.env, .env.generated, real env), so the
// renderer uses the same ports and database as `pnpm infra:up` without its own .env file.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { loadEnvOrExit, readRawEnv, sitesEnv } from '@bf/config';

const require = createRequire(import.meta.url);
const [command = 'dev', ...rest] = process.argv.slice(2);
const env = loadEnvOrExit(sitesEnv, { label: 'sites' });

// The block library's stylesheet and fonts are built files (git-ignored): build them on a fresh checkout.
// The package exports its source entry (src/index.ts): its root is two levels up.
const blocks = dirname(dirname(require.resolve('@bf/site-blocks')));
if (command !== 'start' && !existsSync(join(blocks, 'dist', 'styles.css'))) {
  const built = spawnSync('pnpm', ['--filter', '@bf/site-blocks', 'build'], { stdio: 'inherit' });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

// Only the renderer's own settings come from the repo's .env files: it never sees the owner database URL, object
// storage or API keys that live there for the API. Real environment variables pass through unchanged.
const ownKeys = new Set(Object.keys(sitesEnv.shape));
const fromFiles = Object.fromEntries(
  Object.entries(readRawEnv({ env: {} })).filter(([key, value]) => ownKeys.has(key) && value !== undefined),
);
const nextBin = require.resolve('next/dist/bin/next');
const args = [command, ...(command === 'build' ? [] : ['--port', String(env.SITES_PORT)]), ...rest];
const child = spawn(process.execPath, [nextBin, ...args], {
  stdio: 'inherit',
  env: { ...fromFiles, ...process.env },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 1));
