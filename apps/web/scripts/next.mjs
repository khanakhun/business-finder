#!/usr/bin/env node
// Runs the Next.js CLI with the validated environment from @bf/config (.env, .env.generated, real env), so the
// dashboard uses the same ports and URLs as `pnpm infra:up` without its own .env file.
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { loadEnvOrExit, readRawEnv, webEnv } from '@bf/config';

const [command = 'dev', ...rest] = process.argv.slice(2);

// MapLibre (search map, BF-023) starts its worker from a URL next to its own module, which the bundle does not keep:
// serve the worker and the module it imports from /maplibre/ (results-map.tsx sets the worker URL).
const maplibreDist = join(
  dirname(createRequire(import.meta.url).resolve('maplibre-gl/package.json')),
  'dist',
);
const maplibreOut = join(import.meta.dirname, '..', 'public', 'maplibre');
mkdirSync(maplibreOut, { recursive: true });
for (const file of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
  copyFileSync(join(maplibreDist, file), join(maplibreOut, file));
}
const env = loadEnvOrExit(webEnv, { label: 'web' });
const raw = readRawEnv();
// Resolve Next's CLI from this package rather than relying on node_modules/.bin being on PATH.
const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');
const args = [command, ...(command === 'build' ? [] : ['--port', String(env.WEB_PORT)]), ...rest];
const child = spawn(process.execPath, [nextBin, ...args], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ...Object.fromEntries(Object.entries(raw).filter(([key]) => key.startsWith('NEXT_PUBLIC_'))),
    NEXT_PUBLIC_API_URL: env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_APP_URL: env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_MAP_STYLE_URL: env.NEXT_PUBLIC_MAP_STYLE_URL,
    // Server-side calls (session check in the dashboard layout) may use an internal API address.
    API_URL: env.API_URL,
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 1));
