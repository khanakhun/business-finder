import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { inject } from 'vitest';
import { databaseUrl, PROVIDE_KEY } from './connection.ts';

export interface IsolatedDatabase {
  readonly name: string;
  /** Connection string for the new database (owner role). */
  readonly url: string;
  /** Drops the database, terminating any connections still open. */
  drop(): Promise<void>;
}

/**
 * Clones the migrated template into a fresh database (CREATE DATABASE … TEMPLATE, a file-level copy, so it is
 * fast and needs no migrations). Use one per test file; requires `@bf/testing/db/global-setup`.
 */
export async function createIsolatedDatabase(): Promise<IsolatedDatabase> {
  const pg = inject(PROVIDE_KEY);
  const name = `bf_test_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(databaseUrl(pg, 'postgres'), { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${pg.template}`);
  } finally {
    await admin.end();
  }
  return {
    name,
    url: databaseUrl(pg, name),
    async drop() {
      const dropper = postgres(databaseUrl(pg, 'postgres'), { max: 1, onnotice: () => undefined });
      try {
        await dropper.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    },
  };
}

/** Tables owned by extensions (PostGIS' spatial_ref_sys) are reference data and are never truncated. */
const EXTENSION_TABLES = new Set(['spatial_ref_sys']);

/** Empties every table in `public` (identities restarted) — for tests that use several connections. */
export async function truncateAll(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    const rows = await sql<
      { tablename: string }[]
    >`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    const tables = rows.map((r) => r.tablename).filter((t) => !EXTENSION_TABLES.has(t));
    if (tables.length > 0) {
      await sql.begin(async (tx) => {
        // Append-only tables (audit_logs) refuse TRUNCATE through a trigger: lift it for this transaction only
        // and restore its exact enabled mode afterwards (test databases are owned by the test role).
        const guards = await tx<{ table: string; trigger: string; mode: string }[]>`
          SELECT c.relname AS table, t.tgname AS trigger, t.tgenabled AS mode
          FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND NOT t.tgisinternal AND (t.tgtype & 32) <> 0`;
        for (const guard of guards) {
          await tx.unsafe(`ALTER TABLE "public"."${guard.table}" DISABLE TRIGGER "${guard.trigger}"`);
        }
        await tx.unsafe(
          `TRUNCATE ${tables.map((t) => `"public"."${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
        );
        const enable: Record<string, string> = {
          O: 'ENABLE',
          A: 'ENABLE ALWAYS',
          R: 'ENABLE REPLICA',
          D: 'DISABLE',
        };
        for (const guard of guards) {
          await tx.unsafe(
            `ALTER TABLE "public"."${guard.table}" ${enable[guard.mode] ?? 'ENABLE'} TRIGGER "${guard.trigger}"`,
          );
        }
      });
    }
  } finally {
    await sql.end();
  }
}
