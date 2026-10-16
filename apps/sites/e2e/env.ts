import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

// Same ports and database as `pnpm infra:up`: .env and .env.generated at the repo root, real env wins.
const fileEnv: Record<string, string | undefined> = {};
for (const file of ['../../../.env', '../../../.env.generated']) {
  const url = new URL(file, import.meta.url);
  if (existsSync(url)) Object.assign(fileEnv, parseEnv(readFileSync(url, 'utf8')));
}
export const env: Record<string, string | undefined> = { ...fileEnv, ...process.env };
export const sitesPort = Number(env.SITES_PORT ?? '3100');
export const BASE_DOMAIN = 'sites.localhost';
/** Throwaway secrets of the e2e renderer (never used anywhere else). */
export const REVALIDATE_SECRET = 'e2e-revalidate-secret-not-a-real-one-0123456789';
export const VIEW_SECRET = 'e2e-view-token-secret-not-a-real-one-0123456789';
export const API_URL = 'http://api.e2e.localhost:4999';
/** A site's address on the e2e renderer (Chromium resolves *.localhost to the loopback). */
export const siteUrl = (slug: string, path = '/') => `http://${slug}.${BASE_DOMAIN}:${sitesPort}${path}`;
/** A site's canonical address in a production build: https, no port (as served behind Caddy). */
export const canonicalUrl = (slug: string, path = '/') => `https://${slug}.${BASE_DOMAIN}${path}`;
