import type { DbClient } from './client.ts';
import { type DbTransaction, runInTransaction } from './tx.ts';

class RollbackSignal extends Error {}

/**
 * Runs `fn` inside an ambient transaction (visible to `getExecutor(db)`) and always rolls it back — for tests
 * that use a single connection. Multi-connection tests should use an isolated database or `truncateAll`.
 */
export async function withRollback<T>(db: DbClient, fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
  let result: { value: T } | undefined;
  try {
    await runInTransaction(db, async (tx) => {
      result = { value: await fn(tx) };
      throw new RollbackSignal('rollback');
    });
  } catch (error) {
    if (!(error instanceof RollbackSignal)) throw error;
  }
  if (!result) throw new Error('withRollback: transaction finished without a result');
  return result.value;
}
