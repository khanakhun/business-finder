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

type AfterCommit = () => void | Promise<void>;

interface Ambient {
  readonly db: DbClient;
  readonly tx: DbTransaction;
  /** Callbacks for when the outermost transaction commits (a savepoint keeps its own until it succeeds). */
  readonly afterCommit: AfterCommit[];
}

let reportAfterCommitError: (error: unknown) => void = (error) => {
  console.error('afterCommit callback failed', error);
};

/** Where failures of `afterCommit` callbacks go (the transaction itself has already committed). */
export function onAfterCommitError(handler: (error: unknown) => void): void {
  reportAfterCommitError = handler;
}

async function runCallbacks(callbacks: readonly AfterCommit[]): Promise<void> {
  for (const callback of callbacks) {
    try {
      await callback();
    } catch (error) {
      reportAfterCommitError(error);
    }
  }
}

/**
 * Runs `callback` once the ambient transaction on `db` commits (immediately when there is none). Nothing runs if it
 * rolls back, or if the savepoint it was registered in fails. Callbacks run in order; a failing one is reported
 * through `onAfterCommitError` and does not affect the others or the committed work.
 */
export async function afterCommit(db: DbClient, callback: AfterCommit): Promise<void> {
  const current = ambient.getStore();
  if (current?.db === db) current.afterCommit.push(callback);
  else await runCallbacks([callback]);
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
    const callbacks: AfterCommit[] = [];
    const result = await outer.tx.transaction((savepoint) =>
      ambient.run({ db, tx: savepoint, afterCommit: callbacks }, () => fn(savepoint)),
    );
    // The savepoint succeeded: its callbacks now wait for the outer commit.
    outer.afterCommit.push(...callbacks);
    return result;
  }
  const config = options.isolationLevel ? { isolationLevel: options.isolationLevel } : undefined;
  const callbacks: AfterCommit[] = [];
  const result = await db.transaction(
    (tx) => ambient.run({ db, tx, afterCommit: callbacks }, () => fn(tx)),
    config,
  );
  await runCallbacks(callbacks);
  return result;
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
