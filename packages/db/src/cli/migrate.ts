// pnpm db:migrate — apply pending migrations to DATABASE_URL.
import { runMigrations } from '../migrate.ts';
import { loadCliEnv } from './env.ts';

const env = loadCliEnv();
await runMigrations(env.DATABASE_URL);
console.log('Migrations applied.');
