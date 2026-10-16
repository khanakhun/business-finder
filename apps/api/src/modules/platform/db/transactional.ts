import { type DbClient, runInTransaction, type TransactionOptions } from '@bf/db';

let transactionalDb: DbClient | undefined;

/** Called by DbModule; `@Transactional()` needs the client but decorators cannot use DI. */
export function setTransactionalDb(db: DbClient | undefined): void {
  transactionalDb = db;
}

/**
 * Runs the decorated (async) method inside `runInTransaction`, so every repository call in it shares one
 * transaction through `getExecutor(db)`. Nested transactional methods join the outer transaction.
 */
export function Transactional(options: TransactionOptions = {}): MethodDecorator {
  return (_target, propertyKey, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: unknown[]) => Promise<unknown>;
    descriptor.value = function transactional(this: unknown, ...args: unknown[]) {
      if (!transactionalDb) {
        // Rejected promise, not a synchronous throw: decorated methods are async and callers may `.catch()`.
        return Promise.reject(
          new Error(`@Transactional() on ${String(propertyKey)} used before DbModule initialised`),
        );
      }
      return runInTransaction(transactionalDb, () => original.apply(this, args), options);
    };
    return descriptor;
  };
}
