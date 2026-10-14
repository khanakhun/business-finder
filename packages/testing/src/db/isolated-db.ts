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
      await sql.unsafe(
        `TRUNCATE ${tables.map((t) => `"public"."${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
      );
    }
  } finally {
    await sql.end();
  }
}
