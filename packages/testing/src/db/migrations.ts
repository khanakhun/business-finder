import { readMigrationFiles } from 'drizzle-orm/migrator';
import type postgres from 'postgres';

// Mirror of @bf/db `applyMigrations` (this package cannot import @bf/db, which dev-depends on it): one
// transaction per migration, none for a migration starting with `-- bf:no-transaction` (CREATE INDEX
// CONCURRENTLY), same journal as Drizzle. @bf/db's "is a no-op when re-run" integration test checks they agree.
const NO_TRANSACTION_MARKER = '-- bf:no-transaction';

export async function applyMigrations(sql: postgres.Sql, migrationsFolder: string): Promise<void> {
  await sql`CREATE SCHEMA IF NOT EXISTS drizzle`;
  await sql`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
    id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`;
  for (const migration of readMigrationFiles({ migrationsFolder })) {
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
}
