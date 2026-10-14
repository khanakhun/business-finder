import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/** Committed SQL migrations (Drizzle Kit journal + hand-written files). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Applies pending migrations on a dedicated single connection. Already-applied migrations are skipped, so
 * re-running is a no-op. Never called from app startup (ADR-0004): only `pnpm db:migrate` and deploy jobs.
 */
export async function runMigrations(url: string, migrationsFolder: string = MIGRATIONS_DIR): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end({ timeout: 5 });
  }
}
