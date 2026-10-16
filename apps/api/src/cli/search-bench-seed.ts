// pnpm --filter @bf/api search:bench-seed --org <workspace id> [--businesses 200000] [--embedded 20000]
// Fills a workspace with synthetic businesses for local performance work (BF-022): fake names, places and
// contacts, deterministic per row. Development databases only — it refuses to run with NODE_ENV=production.
import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { closeDb, createDb } from '@bf/db';
import { loadAppEnv } from '../modules/platform/config/app-env.ts';
import { seedSearchBench } from './search-bench/seed.ts';

const { values } = parseArgs({
  options: { org: { type: 'string' }, businesses: { type: 'string' }, embedded: { type: 'string' } },
});
const env = loadAppEnv('http');
if (env.NODE_ENV === 'production') {
  console.error('search:bench-seed writes synthetic data: refusing in production');
  process.exit(1);
}
if (!values.org) {
  console.error('--org <workspace id> is required');
  process.exit(1);
}
const businesses = Number(values.businesses ?? 200_000);
const embedded = Number(values.embedded ?? 20_000);
const db = createDb({ url: env.DATABASE_URL, max: 1, applicationName: 'bf-search-bench-seed' });
try {
  const ms = await seedSearchBench(db, {
    organizationId: values.org,
    businesses,
    embedded,
    embeddingModel: env.AI_EMBEDDING_MODEL,
  });
  console.log(
    `search:bench-seed ${businesses} businesses (${embedded} embedded) in ${(ms / 1000).toFixed(1)} s`,
  );
} finally {
  await closeDb(db);
}
