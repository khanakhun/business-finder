import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres from 'postgres';

/** Committed SQL migrations (Drizzle Kit journal + hand-written files). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * First line of a migration that must run outside a transaction (`CREATE INDEX CONCURRENTLY`, README
 * "Migrations"). Keep such a migration to concurrent index statements only: they are not atomic, so each one
 * should be `IF NOT EXISTS` and safe to re-run.
 */
export const NO_TRANSACTION_MARKER = '-- bf:no-transaction';

/** Serializes concurrent migrators (two deploy jobs, parallel test setups) on the same database. */
const LOCK_KEY = 0x62665f6d; // "bf_m"

/**
 * Applies pending migrations on a dedicated single connection. Already-applied migrations are skipped, so
 * re-running is a no-op. Never called from app startup (ADR-0004): only `pnpm db:migrate` and deploy jobs.
 */
export async function runMigrations(url: string, migrationsFolder: string = MIGRATIONS_DIR): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await applyMigrations(client, migrationsFolder);
  } finally {
    await client.end({ timeout: 5 });
  }
}

/**
 * Drizzle's migrator runs every pending migration in one transaction, which `CREATE INDEX CONCURRENTLY`
 * refuses. This one keeps Drizzle's journal (`drizzle.__drizzle_migrations`: same hashes, same "newer than the
 * last applied" rule) but gives each migration its own transaction, and none to a migration whose first line is
 * {@link NO_TRANSACTION_MARKER}. `@bf/testing` mirrors it for the test template database (it cannot import us).
 * The client must have a single connection (session-level lock, sequential statements).
 */
export async function applyMigrations(sql: postgres.Sql, migrationsFolder: string): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder });
  await sql`SELECT pg_advisory_lock(${LOCK_KEY})`;
  try {
    await sql`CREATE SCHEMA IF NOT EXISTS drizzle`;
    await sql`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`;
    const [last] = await sql<Array<{ created_at: string }>>`
      SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`;
    for (const migration of migrations) {
      if (last && Number(last.created_at) >= migration.folderMillis) continue;
      const statements = migration.sql.map((s) => s.trim()).filter(Boolean);
      const record = (q: postgres.Sql | postgres.TransactionSql) =>
        q`INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES (${migration.hash}, ${migration.folderMillis})`;
      if (statements[0]?.startsWith(NO_TRANSACTION_MARKER)) {
        for (const statement of statements) await sql.unsafe(statement);
        // A concurrent build that failed half-way leaves an INVALID index that `IF NOT EXISTS` would then skip
        // forever: refuse to record the migration until it is dropped (DROP INDEX CONCURRENTLY) and re-run.
        const invalid = await sql<Array<{ name: string }>>`
          SELECT indexrelid::regclass::text AS name FROM pg_index WHERE NOT indisvalid`;
        if (invalid.length > 0) {
          throw new Error(
            `Invalid indexes after a concurrent migration: ${invalid.map((i) => i.name).join(', ')}`,
          );
        }
        await record(sql);
      } else {
        await sql.begin(async (tx) => {
          for (const statement of statements) await tx.unsafe(statement);
          await record(tx);
        });
      }
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(${LOCK_KEY})`;
  }
}
