// pnpm db:reset --yes — development only: drop every object, re-run migrations and seeds.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { runMigrations } from '../migrate.ts';
import { loadCliEnv } from './env.ts';

const env = loadCliEnv();
if (env.NODE_ENV === 'production') {
  console.error('db:reset refuses to run with NODE_ENV=production.');
  process.exit(1);
}
if (!process.argv.includes('--yes')) {
  console.error('db:reset drops ALL data in DATABASE_URL. Re-run with --yes to confirm.');
  process.exit(1);
}

const sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => undefined });
try {
  // Recreating `public` drops extensions installed in it too; migration 0000 reinstalls them and re-grants
  // schema usage to bf_sites_ro.
  await sql.unsafe(
    'DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;',
  );
} finally {
  await sql.end({ timeout: 5 });
}
await runMigrations(env.DATABASE_URL);
console.log('Schema dropped and migrations re-applied.');
const seed = spawnSync(process.execPath, [fileURLToPath(new URL('./seed.ts', import.meta.url))], {
  stdio: 'inherit',
});
process.exit(seed.status ?? 1);
