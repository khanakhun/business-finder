import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

// Same ports and URLs as `pnpm infra:up` / `pnpm dev`: .env and .env.generated at the repo root, real env wins.
const fileEnv: Record<string, string | undefined> = {};
for (const file of ['../../../.env', '../../../.env.generated']) {
  const url = new URL(file, import.meta.url);
  if (existsSync(url)) Object.assign(fileEnv, parseEnv(readFileSync(url, 'utf8')));
}
export const env: Record<string, string | undefined> = { ...fileEnv, ...process.env };
export const webUrl = `http://localhost:${env.WEB_PORT ?? '3000'}`;
export const apiUrl = `http://localhost:${env.API_PORT ?? '4000'}`;
export const workerMetricsUrl = `http://localhost:${env.WORKER_METRICS_PORT ?? '9464'}/metrics`;
