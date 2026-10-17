// pnpm analytics:backfill --since <YYYY-MM-DD> [--org <workspace id>]
// Rebuilds analytics facts from the source tables (BF-058). Idempotent: the facts' source keys are the live
// ingestion's, so nothing is written twice. Dimensions are today's (see application/backfill.ts).
import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { closeDb, createDb } from '@bf/db';
import { AnalyticsBackfill } from '../modules/analytics/application/backfill.ts';
import { DrizzleFactsStore } from '../modules/analytics/infrastructure/drizzle-facts.store.ts';
import { loadAppEnv } from '../modules/platform/config/app-env.ts';

const { values } = parseArgs({ options: { since: { type: 'string' }, org: { type: 'string' } } });
const since = values.since ? new Date(`${values.since}T00:00:00Z`) : null;
if (!since || Number.isNaN(since.getTime())) {
  console.error('Usage: pnpm analytics:backfill --since <YYYY-MM-DD> [--org <workspace id>]');
  process.exit(1);
}
const env = loadAppEnv('http');
// Backfill statements may scan large tables: no statement timeout here.
const db = createDb({
  url: env.DATABASE_URL,
  max: 2,
  applicationName: 'bf-analytics-backfill',
  statementTimeoutMs: 0,
});
try {
  const written = await new AnalyticsBackfill(new DrizzleFactsStore(db)).run(since, values.org);
  for (const [source, count] of Object.entries(written)) console.log(`${source.padEnd(24)} ${count}`);
} finally {
  await closeDb(db);
}
