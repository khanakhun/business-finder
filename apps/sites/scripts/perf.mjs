#!/usr/bin/env node
// node scripts/perf.mjs lighthouse|load — the renderer's performance checks (BF-036) against a production build
// (`pnpm build` first) and the fixture previews (`pnpm sites:seed` first). It starts the renderer, runs the check and
// stops everything. Lighthouse CI and autocannon are pinned and run through `pnpm dlx` (kept out of the lockfile).
//
// The fixtures' images live on `https://assets.bf-sites.test` (a name that resolves nowhere): for Lighthouse, Chrome
// maps that host to a local HTTPS server (throwaway self-signed certificate) drawing a placeholder of each image's
// size, and the view beacon goes to a local endpoint answering 204, so the page loads as it would in production.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadEnvOrExit, sitesEnv } from '@bf/config';

const require = createRequire(import.meta.url);
const [check = 'lighthouse'] = process.argv.slice(2);
const env = loadEnvOrExit(sitesEnv, { label: 'sites' });
const port = String(env.SITES_PORT);
const ASSETS_HOST = 'assets.bf-sites.test';

/** Every fixture image by its URL path, with its size and a colour. */
function fixtureImages() {
  const dir = join(dirname(require.resolve('@bf/site-schema/package.json')), 'fixtures');
  const images = new Map();
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
    const spec = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    for (const asset of spec.assets ?? []) {
      const url = new URL(asset.url);
      images.set(url.pathname, {
        width: asset.width ?? 1200,
        height: asset.height ?? 800,
        color: spec.theme?.palette?.accent ?? '#888888',
      });
    }
  }
  return images;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

const closers = [];
let extraEnv = {};
let chromeFlags = '--headless=new --no-sandbox';
if (check === 'lighthouse') {
  mkdirSync('.lighthouseci/tls', { recursive: true });
  const made = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=${ASSETS_HOST}`,
      '-keyout',
      '.lighthouseci/tls/key.pem',
      '-out',
      '.lighthouseci/tls/cert.pem',
    ],
    { stdio: 'ignore' },
  );
  if (made.status !== 0) throw new Error('openssl could not make a throwaway certificate');
  const images = fixtureImages();
  const assets = createHttpsServer(
    { key: readFileSync('.lighthouseci/tls/key.pem'), cert: readFileSync('.lighthouseci/tls/cert.pem') },
    (request, response) => {
      const image = images.get(new URL(request.url ?? '/', `https://${ASSETS_HOST}`).pathname);
      if (!image) return response.writeHead(404).end();
      response.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=31536000',
      });
      response.end(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}" viewBox="0 0 ${image.width} ${image.height}"><rect width="100%" height="100%" fill="${image.color}"/></svg>`,
      );
    },
  );
  const assetsPort = await listen(assets);
  const beacon = createHttpServer((_request, response) => response.writeHead(204).end());
  const beaconPort = await listen(beacon);
  closers.push(
    () => assets.close(),
    () => beacon.close(),
  );
  extraEnv = { SITES_ASSETS_BASE_URL: `https://${ASSETS_HOST}`, API_URL: `http://127.0.0.1:${beaconPort}` };
  chromeFlags += ` --host-resolver-rules="MAP ${ASSETS_HOST}:443 127.0.0.1:${assetsPort}" --ignore-certificate-errors`;
}

// A production build requires both shared secrets: throwaway ones unless real ones are set.
const throwaway = 'perf-run-throwaway-secret-not-a-real-one-0123456789';
const server = spawn(process.execPath, ['scripts/next.mjs', 'start'], {
  stdio: 'ignore',
  env: {
    ...process.env,
    SITES_REVALIDATE_SECRET: process.env.SITES_REVALIDATE_SECRET ?? throwaway,
    SITES_VIEW_TOKEN_SECRET: process.env.SITES_VIEW_TOKEN_SECRET ?? throwaway,
    ...extraEnv,
  },
});
const stop = () => {
  server.kill('SIGTERM');
  for (const close of closers) close();
};
process.on('exit', stop);

for (let tries = 0; ; tries += 1) {
  try {
    if ((await fetch(`http://127.0.0.1:${port}/health/ready`)).ok) break;
  } catch {}
  if (tries > 60) throw new Error('the renderer did not start');
  await sleep(500);
}

let status = 0;
if (check === 'lighthouse') {
  status =
    spawnSync('pnpm', ['dlx', '@lhci/cli@0.15.1', 'autorun', '--config=../lighthouserc.cjs'], {
      cwd: '.lighthouseci',
      stdio: 'inherit',
      env: { ...process.env, SITES_PORT: port, LHCI_CHROME_FLAGS: chromeFlags },
    }).status ?? 1;
} else {
  // A cached page under load: 200 requests per second over 10 connections, p95 under 50 ms (ticket), by Host header (autocannon resolves
  // with the system resolver, which may not know *.localhost).
  status =
    spawnSync(
      'pnpm',
      [
        'dlx',
        'autocannon@8.0.0',
        // LOAD_ARGS overrides the load (e.g. `--connections 1 --duration 10` for one request at a time).
        ...(process.env.LOAD_ARGS?.split(' ') ?? [
          '--connections',
          '10',
          '--duration',
          '20',
          '--overallRate',
          '200',
        ]),
        '--headers',
        'host=salon-gustavia-demo01.sites.localhost',
        `http://127.0.0.1:${port}/`,
      ],
      { stdio: 'inherit' },
    ).status ?? 1;
}
stop();
process.exit(status);
