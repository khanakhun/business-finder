import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.ts';

export type DbSchema = typeof schema;
export type DbClient = PostgresJsDatabase<DbSchema> & { $client: postgres.Sql };

export interface CreateDbOptions {
  readonly url: string;
  /** Pool size per process. */
  readonly max?: number;
  /** Seconds before an idle connection is closed. */
  readonly idleTimeout?: number;
  /** Shown in `pg_stat_activity` and logs, e.g. `bf-api`, `bf-worker`. */
  readonly applicationName?: string;
  /** Every statement is cancelled after this many milliseconds (0 disables). */
  readonly statementTimeoutMs?: number;
  /** Every transaction is read-only (apps/sites). */
  readonly readOnly?: boolean;
}

/**
 * Creates a Drizzle client over a postgres.js pool. Session settings are sent as startup parameters, so they
 * apply to every pooled connection without an extra round-trip.
 */
export function createDb(options: CreateDbOptions): DbClient {
  const client = postgres(options.url, {
    max: options.max ?? 10,
    idle_timeout: options.idleTimeout ?? 20,
    // Postgres NOTICEs (e.g. "extension already exists") are noise in app logs.
    onnotice: () => undefined,
    connection: {
      application_name: options.applicationName ?? 'bf',
      statement_timeout: options.statementTimeoutMs ?? 30_000,
      ...(options.readOnly ? { default_transaction_read_only: true } : {}),
    },
  });
  return drizzle(client, { schema, casing: 'snake_case' });
}

/** Closes the pool; waits up to `timeoutSeconds` for running queries. */
export async function closeDb(db: DbClient, timeoutSeconds = 5): Promise<void> {
  await db.$client.end({ timeout: timeoutSeconds });
}
