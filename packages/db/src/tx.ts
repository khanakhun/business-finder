import { AsyncLocalStorage } from 'node:async_hooks';
import type { DbClient } from './client.ts';

/** The transaction object Drizzle passes to `db.transaction(cb)`. */
export type DbTransaction = Parameters<Parameters<DbClient['transaction']>[0]>[0];
/** What repositories run queries on: the ambient transaction, or the root client outside one. */
export type DbExecutor = DbClient | DbTransaction;

type IsolationLevel = 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable';

export interface TransactionOptions {
  /** Only valid on the outermost call; a nested call cannot change it. */
  readonly isolationLevel?: IsolationLevel;
  /** When nested, run in a SAVEPOINT so a failure here can be caught without aborting the outer work. */
  readonly savepoint?: boolean;
}

interface Ambient {
  readonly db: DbClient;
  readonly tx: DbTransaction;
}

const ambient = new AsyncLocalStorage<Ambient>();

/** Thrown when a nested call asks for an isolation level the outer transaction already fixed. */
export class NestedIsolationLevelError extends Error {
  constructor() {
    super('A nested runInTransaction cannot set isolationLevel; set it on the outermost call.');
    this.name = 'NestedIsolationLevelError';
  }
}

/**
 * Unit of Work: runs `fn` in a transaction that repositories pick up through `getExecutor(db)`, so they never
 * take a `tx` argument. Nested calls join the outer transaction (or a savepoint with `{ savepoint: true }`);
 * any error thrown out of the outermost call rolls everything back.
 */
export async function runInTransaction<T>(
  db: DbClient,
  fn: (tx: DbTransaction) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const outer = ambient.getStore();
  if (outer?.db === db) {
    if (options.isolationLevel) throw new NestedIsolationLevelError();
    if (!options.savepoint) return fn(outer.tx);
    return outer.tx.transaction((savepoint) => ambient.run({ db, tx: savepoint }, () => fn(savepoint)));
  }
  const config = options.isolationLevel ? { isolationLevel: options.isolationLevel } : undefined;
  return db.transaction((tx) => ambient.run({ db, tx }, () => fn(tx)), config);
}

/** The ambient transaction started by `runInTransaction` on this client, or the client itself. */
export function getExecutor(db: DbClient): DbExecutor {
  const current = ambient.getStore();
  return current?.db === db ? current.tx : db;
}

/** True inside `runInTransaction` for this client. */
export function isInTransaction(db: DbClient): boolean {
  return ambient.getStore()?.db === db;
}
